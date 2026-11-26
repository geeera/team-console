import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureGit, makeRunnerHome } from '../testing/job-fixture';
import { runnerGitEnv } from './git';
import { cloneForJob, mirrorPathOf, syncMirror, vendorPlugin, type GitEnvs } from './workspace';

/**
 * #721, threat model C4 "vendored plugin swapped by a job": whoever can write the mirror must not be able to choose
 * the commit the next job's plugin and clone come from, neither through the fetch refspec nor through `HEAD`.
 */

// Several real git runs per test (sync, tamper, sync, vendor, clone): the default 5 s is short on a loaded host.
describe('mirror refs and HEAD stay the upstream’s (#721)', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let envs: GitEnvs;

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    const jobHome = join(fixture.root, 'job-home');
    await mkdir(jobHome);
    const runner = runnerGitEnv({ PATH: process.env['PATH'], HOME: join(fixture.root, 'runner-home') });
    envs = { runner, job: { PATH: runner['PATH'] ?? '/usr/bin:/bin', HOME: jobHome, LC_ALL: 'C' } };
    // A branch an attacker pushed upstream, with its own plugin.
    fixtureGit(['-C', fixture.repo, 'checkout', '-q', '-b', 'evil']);
    await writeFile(join(fixture.repo, '.claude', 'product-team', 'README.md'), 'evil plugin\n');
    fixtureGit(['-C', fixture.repo, 'commit', '-q', '-am', 'evil']);
    fixtureGit(['-C', fixture.repo, 'checkout', '-q', 'main']);
  });

  afterEach(async () => {
    await fixture.done();
  });

  const mirror = (): string => mirrorPathOf(fixture.home, 'team-console');
  const vendoredReadme = async (): Promise<string> =>
    await readFile(join(await vendorPlugin(fixture.home, mirror(), envs.job), 'README.md'), 'utf8');

  it('refuses a mirror whose fetch refspec maps another branch onto the default one, before fetching', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    const before = fixtureGit(['--git-dir', mirror(), 'rev-parse', 'refs/heads/main']);
    fixtureGit([
      '--git-dir',
      mirror(),
      'config',
      '--replace-all',
      'remote.origin.fetch',
      '+refs/heads/evil:refs/heads/main',
    ]);

    await expect(syncMirror(fixture.home, 'team-console', fixture.repo, envs)).rejects.toMatchObject({
      reason: 'git-config-refused',
      message: expect.stringContaining('remote.origin.fetch (unexpected value, local)') as unknown,
    });
    expect(fixtureGit(['--git-dir', mirror(), 'rev-parse', 'refs/heads/main'])).toBe(before);
    expect(await vendoredReadme()).toBe('plugin\n');
  });

  it('puts back refs a job rewrote in the mirror: the fetch uses its own refspec, forced', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    const evil = fixtureGit(['--git-dir', mirror(), 'rev-parse', 'refs/heads/evil']).trim();
    fixtureGit(['--git-dir', mirror(), 'update-ref', 'refs/heads/main', evil]);
    expect(await vendoredReadme()).toBe('evil plugin\n');

    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    expect(await vendoredReadme()).toBe('plugin\n');
  });

  it('points a HEAD a job moved back at the upstream’s default branch before the plugin is vendored', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    fixtureGit(['--git-dir', mirror(), 'symbolic-ref', 'HEAD', 'refs/heads/evil']);
    expect(await vendoredReadme()).toBe('evil plugin\n');

    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    expect(fixtureGit(['--git-dir', mirror(), 'symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    expect(await vendoredReadme()).toBe('plugin\n');
    const clone = join(fixture.root, 'clone');
    await cloneForJob(mirror(), clone, fixture.repo, envs);
    expect(fixtureGit(['-C', clone, 'log', '-1', '--format=%s']).trim()).toBe('init');
  });

  it('follows the upstream when its default branch legitimately changes', async () => {
    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    fixtureGit(['-C', fixture.repo, 'branch', '-q', 'trunk', 'main']);
    fixtureGit(['-C', fixture.repo, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);

    await syncMirror(fixture.home, 'team-console', fixture.repo, envs);
    expect(fixtureGit(['--git-dir', mirror(), 'symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/trunk');
  });
});
