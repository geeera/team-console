import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRefusal } from '../jobs/refusal';
import { fixtureGit } from '../testing/job-fixture';
import { assertCleanGitConfig, parseGitConfigList, refusedGitConfig } from './git-config';

/** Threat model C3 cross-job row (b), ADR 0008 decision 7: every refused key, judged on a real repository. */

describe('git config refusal table', () => {
  let dir: string;
  let repo: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcr-git-'));
    repo = join(dir, 'repo');
    fixtureGit(['init', '-q', repo]);
    env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(dir, 'job-home'), LC_ALL: 'C' };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const gitDir = (): string => join(repo, '.git');

  it('accepts a fresh repository', async () => {
    await expect(assertCleanGitConfig(gitDir(), env, null)).resolves.toBeUndefined();
  });

  it.each([
    ['core.hooksPath', '/tmp/hooks'],
    ['core.fsmonitor', '/tmp/monitor.sh'],
    ['core.sshCommand', 'ssh -o ProxyCommand=evil'],
    ['include.path', '/tmp/extra.gitconfig'],
    ['includeIf.gitdir:/.path', '/tmp/extra.gitconfig'],
    ['credential.helper', '!/tmp/steal.sh'],
    ['credential.https://github.com.helper', 'store'],
    ['merge.custom.hooks', 'x'],
    ['Foo.Bar.Hooks', '1'],
  ])('refuses %s', async (key, value) => {
    fixtureGit(['-C', repo, 'config', key, value]);
    const refusal: unknown = await assertCleanGitConfig(gitDir(), env, null).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LaunchRefusal);
    expect(refusal).toMatchObject({ reason: 'git-config-refused' });
    expect((refusal as Error).message).not.toContain(value);
  });

  it('judges the job HOME’s global file too', async () => {
    const home = join(dir, 'job-home');
    await mkdir(home);
    await writeFile(join(home, '.gitconfig'), '[core]\n\tfsmonitor = /tmp/monitor.sh\n');
    await expect(assertCleanGitConfig(gitDir(), env, null)).rejects.toMatchObject({
      reason: 'git-config-refused',
    });
  });

  it('accepts the runner’s own credential helper and refuses a foreign one', () => {
    const entries = parseGitConfigList(
      'local\0file:config\0credential.helper\n/runner/helper\0local\0file:config\0credential.helper\n/tmp/evil\0',
    );
    expect(refusedGitConfig(entries.slice(0, 1), '/runner/helper')).toEqual([]);
    expect(refusedGitConfig(entries, '/runner/helper')).toEqual([
      'credential.helper (credential.helper (foreign), local)',
    ]);
  });

  it('ignores the system scope (the host administrator’s file, e.g. osxkeychain)', () => {
    const entries = parseGitConfigList('system\0file:/etc/gitconfig\0credential.helper\nosxkeychain\0');
    expect(entries).toEqual([
      { scope: 'system', origin: 'file:/etc/gitconfig', key: 'credential.helper', value: 'osxkeychain' },
    ]);
    expect(refusedGitConfig(entries, null)).toEqual([]);
  });

  it('parses a value with newlines and an empty value', () => {
    expect(parseGitConfigList('local\0file:c\0a.b\nline1\nline2\0local\0file:c\0a.c\0')).toEqual([
      { scope: 'local', origin: 'file:c', key: 'a.b', value: 'line1\nline2' },
      { scope: 'local', origin: 'file:c', key: 'a.c', value: '' },
    ]);
  });
});
