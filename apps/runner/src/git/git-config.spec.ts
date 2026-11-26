import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRefusal } from '../jobs/refusal';
import { fixtureGit } from '../testing/job-fixture';
import {
  ALLOWED_GIT_KEYS,
  assertCleanGitConfig,
  CLONE_REFSPEC,
  MIRROR_REFSPEC,
  parseGitConfigList,
  refusedGitConfig,
  type ExpectedRepository,
} from './git-config';

/**
 * Threat model C3 cross-job row (b), ADR 0008 decision 7: the allow-list of keys and values the runner's git writes
 * (#694, #721), judged on real repositories; every key of the earlier deny-list, and the ones it missed, is refused.
 */

const UPSTREAM = 'https://github.com/geeera/team-console.git';
const asClone: ExpectedRepository = { kind: 'clone', originUrl: UPSTREAM, allowedHelper: null };

describe('git config allow-list', () => {
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
    await expect(assertCleanGitConfig(gitDir(), env, asClone)).resolves.toBeUndefined();
  });

  it('accepts a sha256 repository with reftable refs', async () => {
    const modern = join(dir, 'modern');
    fixtureGit(['init', '-q', '--object-format=sha256', '--ref-format=reftable', modern]);
    await expect(assertCleanGitConfig(join(modern, '.git'), env, asClone)).resolves.toBeUndefined();
  });

  /** A mirror and a clone exactly as the runner makes them: clone --mirror, fetch, clone, set-url. */
  const runnerRepositories = (): { mirror: string; clone: string } => {
    fixtureGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    const mirror = join(dir, 'mirror');
    const clone = join(dir, 'clone');
    fixtureGit(['clone', '--mirror', '--quiet', '--template=', '--', repo, mirror]);
    fixtureGit(['--git-dir', mirror, 'fetch', '--prune', '--quiet', 'origin', MIRROR_REFSPEC]);
    fixtureGit(['clone', '--no-hardlinks', '--quiet', '--template=', '--', mirror, clone]);
    fixtureGit(['-C', clone, 'remote', 'set-url', 'origin', UPSTREAM]);
    return { mirror, clone: join(clone, '.git') };
  };
  const asMirror = (): ExpectedRepository => ({ kind: 'mirror', originUrl: repo, allowedHelper: null });

  it('accepts the mirror and the clone exactly as the runner makes them', async () => {
    const { mirror, clone } = runnerRepositories();
    await expect(assertCleanGitConfig(mirror, env, asMirror())).resolves.toBeUndefined();
    await expect(assertCleanGitConfig(clone, env, asClone)).resolves.toBeUndefined();
  });

  it.each([
    ['core.symlinks', 'false'],
    ['remote.origin.url', UPSTREAM],
    ['remote.origin.fetch', CLONE_REFSPEC],
    ['branch.feature/x.remote', 'origin'],
    ['branch.feature/x.merge', 'refs/heads/feature/x'],
  ])('accepts %s on a clone', async (key, value) => {
    fixtureGit(['-C', repo, 'config', key, value]);
    await expect(assertCleanGitConfig(gitDir(), env, asClone)).resolves.toBeUndefined();
  });

  it('labels every allow-list rule', () => {
    expect(ALLOWED_GIT_KEYS.map((rule) => rule.label)).toEqual([
      'core.repositoryFormatVersion',
      'core.bare',
      'core filesystem flags',
      'extensions.objectFormat',
      'extensions.refStorage',
      'remote.origin.url',
      'remote.origin.fetch',
      'remote.origin.mirror',
      'remote.origin.tagOpt',
      'remote.origin.promisor',
      'remote.origin.partialCloneFilter',
      'extensions.partialClone',
      'branch.<name>.remote',
      'branch.<name>.merge',
    ]);
  });

  // #685, ADR 0009 d.5: the reviewer's blob-less clone writes promisor keys; only a clone made partial may hold them.
  it('accepts a partial clone exactly as the runner makes it, and only when it made it partial', async () => {
    const { mirror } = runnerRepositories();
    const partial = join(dir, 'partial');
    fixtureGit([
      '-c',
      `remote.origin.uploadpack=git -c uploadpack.allowFilter=true upload-pack`,
      'clone',
      '--quiet',
      '--template=',
      '--filter=blob:none',
      '--depth',
      '1',
      '--no-single-branch',
      '--upload-pack',
      'git -c uploadpack.allowFilter=true upload-pack',
      '--',
      `file://${mirror}`,
      partial,
    ]);
    fixtureGit(['-C', partial, 'remote', 'set-url', 'origin', UPSTREAM]);
    const partialDir = join(partial, '.git');
    await expect(
      assertCleanGitConfig(partialDir, env, { ...asClone, partial: true }),
    ).resolves.toBeUndefined();
    await expect(assertCleanGitConfig(partialDir, env, asClone)).rejects.toMatchObject({
      reason: 'git-config-refused',
      message: expect.stringContaining('remote.origin.promisor (unexpected value, local)') as unknown,
    });
  });

  it.each([
    ['remote.origin.promisor', 'false'],
    ['remote.origin.partialclonefilter', 'blob:limit=1'],
    ['extensions.partialclone', 'evil'],
  ])('refuses %s = %s on a partial clone', (key, value) => {
    const entries = [{ scope: 'local', origin: 'file:.git/config', key, value }];
    expect(refusedGitConfig(entries, { ...asClone, partial: true })).toEqual([
      `${key} (unexpected value, local)`,
    ]);
  });

  it.each(['remote.origin.promisor', 'remote.origin.partialclonefilter', 'extensions.partialclone'])(
    'refuses %s on the mirror, which is never partial',
    (key) => {
      const value =
        key === 'remote.origin.promisor' ? 'true' : key.endsWith('filter') ? 'blob:none' : 'origin';
      const entries = [{ scope: 'local', origin: 'file:config', key, value }];
      expect(refusedGitConfig(entries, { ...asMirror(), partial: true })).toEqual([
        `${key} (unexpected value, local)`,
      ]);
    },
  );

  // #721: an allow-listed key with a value the runner never writes; the refspec swap is the plugin-swap vector.
  it.each([
    ['mirror', 'remote.origin.fetch', '+refs/heads/evil:refs/heads/main'],
    ['mirror', 'remote.origin.fetch', CLONE_REFSPEC],
    ['mirror', 'remote.origin.mirror', 'false'],
    ['mirror', 'remote.origin.tagOpt', '--tags'],
    ['mirror', 'remote.origin.url', '/tmp/evil'],
    ['mirror', 'core.bare', 'false'],
    ['clone', 'remote.origin.fetch', MIRROR_REFSPEC],
    ['clone', 'remote.origin.url', '/tmp/evil'],
    ['clone', 'remote.origin.mirror', 'true'],
    ['clone', 'core.bare', 'true'],
    ['clone', 'branch.main.merge', 'refs/heads/evil'],
    ['clone', 'branch.main.remote', '/tmp/evil'],
  ] as const)('refuses %s %s = %s', async (kind, key, value) => {
    const { mirror, clone } = runnerRepositories();
    const target = kind === 'mirror' ? mirror : clone;
    fixtureGit(['--git-dir', target, 'config', '--replace-all', key, value]);
    const refusal: unknown = await assertCleanGitConfig(
      target,
      env,
      kind === 'mirror' ? asMirror() : asClone,
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ reason: 'git-config-refused' });
    expect((refusal as Error).message).toContain('(unexpected value, local)');
    expect((refusal as Error).message).not.toContain(value);
  });

  // #721 (low): git subsections are case-sensitive, so `remote.ORIGIN` is a second remote, not `origin`.
  it.each(['ORIGIN', 'Origin'])('refuses remote.%s.url as another remote', async (name) => {
    const { mirror } = runnerRepositories();
    fixtureGit(['--git-dir', mirror, 'config', `remote.${name}.url`, repo]);
    await expect(assertCleanGitConfig(mirror, env, asMirror())).rejects.toMatchObject({
      reason: 'git-config-refused',
      message: expect.stringContaining(`remote.${name}.url (not allow-listed, local)`) as unknown,
    });
  });

  // A real git stops reading such a repository's config (or fails on it), so these are judged on a listing.
  it.each([
    ['core.repositoryformatversion', '2'],
    ['extensions.objectformat', 'sha512'],
    ['extensions.refstorage', 'evil'],
    ['core.filemode', 'yes'],
  ])('refuses %s = %s', (key, value) => {
    const entries = parseGitConfigList(`local\0file:config\0${key}\n${value}\0`);
    expect(refusedGitConfig(entries, asClone)).toEqual([`${key} (unexpected value, local)`]);
  });

  it('compares section and variable case-insensitively, as git does', () => {
    const entries = parseGitConfigList(
      'local\0file:config\0REMOTE.origin.URL\nhttps://github.com/geeera/team-console.git\0',
    );
    expect(refusedGitConfig(entries, asClone)).toEqual([]);
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
    ['filter.lfs.clean', '/tmp/clean.sh'],
    ['filter.lfs.smudge', '/tmp/smudge.sh'],
    ['filter.lfs.process', '/tmp/process.sh'],
    ['remote.origin.uploadpack', '/tmp/upload.sh'],
    ['remote.origin.receivepack', '/tmp/receive.sh'],
    ['core.gitProxy', '/tmp/proxy.sh'],
    ['url./tmp/evil.insteadOf', 'https://github.com/'],
    ['url./tmp/evil.pushInsteadOf', 'https://github.com/'],
    ['protocol.ext.allow', 'always'],
    ['protocol.allow', 'always'],
    ['core.pager', '/tmp/pager.sh'],
    ['diff.external', '/tmp/diff.sh'],
    ['core.askPass', '/tmp/askpass.sh'],
    ['core.editor', '/tmp/editor.sh'],
    ['core.alternateRefsCommand', '/tmp/alt.sh'],
    ['remote.origin.vcs', 'evil'],
    ['remote.origin.proxy', 'http://evil.invalid:3128'],
    ['http.proxy', 'http://evil.invalid:3128'],
    ['http.https://github.com/.proxy', 'http://evil.invalid:3128'],
    ['gpg.program', '/tmp/gpg.sh'],
    ['gpg.ssh.program', '/tmp/ssh-keygen.sh'],
    ['diff.bin.textconv', '/tmp/textconv.sh'],
    ['diff.bin.command', '/tmp/diff-command.sh'],
    ['merge.evil.driver', '/tmp/merge.sh %O %A %B'],
    ['submodule.sub.update', '!/tmp/update.sh'],
    // Missed by the deny-list (#694): transport weakening of the mirror fetch.
    ['http.sslVerify', 'false'],
    ['http.https://github.com/.sslVerify', 'false'],
    ['http.sslCAInfo', '/tmp/evil-ca.pem'],
    ['http.sslCAPath', '/tmp/evil-ca'],
    ['http.curloptResolve', 'github.com:443:203.0.113.7'],
    // Missed by the deny-list (#694): command keys.
    ['sequence.editor', '/tmp/editor.sh'],
    ['pager.log', '/tmp/pager.sh'],
    ['uploadpack.packObjectsHook', '/tmp/pack.sh'],
    ['tar.tgz.command', '/tmp/tar.sh'],
    // Only `origin` is the runner's; a second remote or another key of it is not.
    ['remote.evil.url', '/tmp/evil'],
    ['remote.origin.pushurl', '/tmp/evil'],
    ['branch.main.pushRemote', 'evil'],
    ['extensions.worktreeConfig', 'true'],
    // Harmless, but not written by the runner: the list is closed, not a guess at what is dangerous.
    ['user.name', 'Job'],
  ])('refuses %s', async (key, value) => {
    fixtureGit(['-C', repo, 'config', key, value]);
    const refusal: unknown = await assertCleanGitConfig(gitDir(), env, asClone).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(LaunchRefusal);
    expect(refusal).toMatchObject({ reason: 'git-config-refused' });
    expect((refusal as Error).message).toContain('local)');
    expect((refusal as Error).message).not.toContain(value);
  });

  it('refuses an objects/info/alternates file (not config, so not in the listing)', async () => {
    await mkdir(join(gitDir(), 'objects', 'info'), { recursive: true });
    await writeFile(join(gitDir(), 'objects', 'info', 'alternates'), '/tmp/other/objects\n');
    await expect(assertCleanGitConfig(gitDir(), env, asClone)).rejects.toMatchObject({
      reason: 'git-config-refused',
    });
  });

  it('judges the job HOME’s global file too', async () => {
    const home = join(dir, 'job-home');
    await mkdir(home);
    await writeFile(join(home, '.gitconfig'), '[http]\n\tsslVerify = false\n');
    await expect(assertCleanGitConfig(gitDir(), env, asClone)).rejects.toMatchObject({
      reason: 'git-config-refused',
      message: expect.stringContaining('http.sslverify (not allow-listed, global)') as unknown,
    });
  });

  it('accepts the runner’s own credential helper and refuses a foreign one', () => {
    const withHelper: ExpectedRepository = { ...asClone, allowedHelper: '/runner/helper' };
    const entries = parseGitConfigList(
      'local\0file:config\0credential.helper\n/runner/helper\0local\0file:config\0credential.helper\n/tmp/evil\0',
    );
    expect(refusedGitConfig(entries.slice(0, 1), withHelper)).toEqual([]);
    expect(refusedGitConfig(entries, withHelper)).toEqual([
      'credential.helper (foreign credential helper, local)',
    ]);
  });

  it('ignores the system scope (the host administrator’s file, e.g. osxkeychain)', () => {
    const entries = parseGitConfigList('system\0file:/etc/gitconfig\0credential.helper\nosxkeychain\0');
    expect(entries).toEqual([
      { scope: 'system', origin: 'file:/etc/gitconfig', key: 'credential.helper', value: 'osxkeychain' },
    ]);
    expect(refusedGitConfig(entries, asClone)).toEqual([]);
  });

  it('judges the command scope like any other', () => {
    const entries = parseGitConfigList('command\0command line:\0http.sslverify\nfalse\0');
    expect(refusedGitConfig(entries, asClone)).toEqual(['http.sslverify (not allow-listed, command)']);
  });

  it('parses a value with newlines and an empty value', () => {
    expect(parseGitConfigList('local\0file:c\0a.b\nline1\nline2\0local\0file:c\0a.c\0')).toEqual([
      { scope: 'local', origin: 'file:c', key: 'a.b', value: 'line1\nline2' },
      { scope: 'local', origin: 'file:c', key: 'a.c', value: '' },
    ]);
  });
});
