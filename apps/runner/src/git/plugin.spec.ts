import { mkdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fixtureGit, makeRunnerHome } from '../testing/job-fixture';
import { runnerGitEnv } from './git';
import { cloneForJob, mirrorPathOf, syncMirror, vendorPlugin, type GitEnvs } from './workspace';

/**
 * Threat model C4 "vendored plugin swapped" and C3 row (b) (ADR 0008 decision 7): the plugin comes read-only from
 * the default branch, outside the clone; the mirror and the clone are refused when tampered with.
 */

describe('mirror, clone and the vendored plugin', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let envs: GitEnvs;
  let jobHome: string;

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    jobHome = join(fixture.root, 'job-home');
    await mkdir(jobHome);
    const runner = runnerGitEnv({ PATH: process.env['PATH'], HOME: join(fixture.root, 'runner-home') });
    envs = { runner, job: { PATH: runner['PATH'] ?? '/usr/bin:/bin', HOME: jobHome, LC_ALL: 'C' } };
  });

  afterEach(async () => {
    await fixture.done();
  });

  it('vendors the plugin read-only, outside the clone, and re-extracts a tampered copy', async () => {
    const mirror = await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    const clone = join(fixture.root, 'clone');
    await cloneForJob(mirror, clone, fixture.repo, envs);
    const plugin = await vendorPlugin(fixture.home, mirror, envs.job);

    expect(relative(clone, plugin).startsWith('..')).toBe(true);
    expect(plugin.startsWith(join(fixture.home, 'plugin'))).toBe(true);
    expect(await readFile(join(plugin, 'README.md'), 'utf8')).toBe('plugin\n');
    expect((await stat(plugin)).mode & 0o222).toBe(0);
    expect((await stat(join(plugin, 'README.md'))).mode & 0o777).toBe(0o444);
    expect((await stat(join(plugin, 'scripts', 'pr'))).mode & 0o777).toBe(0o555);
    await expect(writeFile(join(plugin, 'README.md'), 'swapped')).rejects.toMatchObject({ code: 'EACCES' });

    // A process of the same uid can still chmod it back (the `none` backend has no second uid): the next job's
    // extraction replaces whatever it left.
    await chmod(join(plugin, 'README.md'), 0o644);
    await writeFile(join(plugin, 'README.md'), 'swapped');
    const again = await vendorPlugin(fixture.home, mirror, envs.job);
    expect(again).toBe(plugin);
    expect(await readFile(join(again, 'README.md'), 'utf8')).toBe('plugin\n');
  });

  it('takes the plugin from the default branch, not from the job’s clone', async () => {
    const mirror = await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    const clone = join(fixture.root, 'clone');
    await cloneForJob(mirror, clone, fixture.repo, envs);
    await writeFile(join(clone, '.claude', 'product-team', 'README.md'), 'swapped in the clone');
    const plugin = await vendorPlugin(fixture.home, mirror, envs.job);
    expect(await readFile(join(plugin, 'README.md'), 'utf8')).toBe('plugin\n');
  });

  it('refuses a default branch without the plugin', async () => {
    fixtureGit(['rm', '-q', '-r', '.claude'], fixture.repo);
    fixtureGit(['commit', '-q', '-m', 'drop plugin'], fixture.repo);
    const mirror = await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    await expect(vendorPlugin(fixture.home, mirror, envs.job)).rejects.toMatchObject({
      reason: 'plugin-missing',
    });
  });

  it('points the clone’s origin at the upstream, never at the mirror', async () => {
    const mirror = await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    const clone = join(fixture.root, 'clone');
    await cloneForJob(mirror, clone, 'https://github.com/geeera/team-console.git', envs);
    expect(fixtureGit(['-C', clone, 'remote', 'get-url', 'origin']).trim()).toBe(
      'https://github.com/geeera/team-console.git',
    );
    expect(fixtureGit(['-C', clone, 'log', '--format=%s']).trim()).toBe('init');
  });

  it('refuses a mirror whose config a job poisoned, before fetching it', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    fixtureGit([
      '--git-dir',
      mirrorPathOf(fixture.home, 'team-console'),
      'config',
      'core.fsmonitor',
      '/tmp/x',
    ]);
    await expect(syncMirror(fixture.home, 'team-console', fixture.repo, envs)).rejects.toMatchObject({
      reason: 'git-config-refused',
    });
  });

  it('refuses a mirror with a planted hook', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    const hooks = join(mirrorPathOf(fixture.home, 'team-console'), 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'reference-transaction'), '#!/bin/sh\ntouch /tmp/pwned\n', { mode: 0o755 });
    await expect(syncMirror(fixture.home, 'team-console', fixture.repo, envs)).rejects.toMatchObject({
      reason: 'git-config-refused',
    });
  });

  it('fetches new commits into an existing mirror', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    await writeFile(join(fixture.repo, 'CHANGE.md'), 'x');
    fixtureGit(['add', '.'], fixture.repo);
    fixtureGit(['commit', '-q', '-m', 'second'], fixture.repo);
    const mirror = await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    expect(fixtureGit(['--git-dir', mirror, 'log', '--format=%s', 'main']).trim().split('\n')).toEqual([
      'second',
      'init',
    ]);
  });
});
