import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerReleaseDto } from '@shared/contracts';
import type { Exec, ExecOptions, ExecResult } from '../host/exec';
import { AUTO_UPDATE_INTERVAL_MS, autoUpdater } from './auto-update';
import { RELEASE_FILES, attestationVerifyArgs, releasePlatformOf, tarballNameOf } from './release-identity';
import { UpdateError, applyUpdate, checkForUpdate, type ApplyDeps, type UpdateProblem } from './update';

/**
 * Threat model C11 rows 1–2 and RR13 (ADR 0008 decision 10): `update` installs only a release that
 * `gh attestation verify` accepts against the identity pinned in the binary, never a lower version, never one below
 * the console's minimum, never with policy `off`, and never without `gh`. Nothing in the install directory changes
 * before every check has passed.
 */

const TARGET = '0.3.0';
const INSTALLED = '0.2.0';
const OLD_BUNDLE = 'old bundle\n';

const release = (version: string | null, minimumVersion: string | null = null) =>
  vi.fn(async (): Promise<RunnerReleaseDto> => ({ version, minimumVersion }));

async function refusal(promise: Promise<unknown>): Promise<UpdateProblem> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof UpdateError)) {
    throw new Error(`expected an UpdateError, got ${String(error)}`);
  }
  return error.problem;
}

describe('update: which version (C11 row 2, RR13)', () => {
  it('refuses with policy off before asking the console', async () => {
    const answer = release(TARGET);
    expect(await refusal(checkForUpdate({ currentVersion: INSTALLED, policy: 'off', release: answer }))).toBe(
      'policy-off',
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it('refuses a version lower than the installed one', async () => {
    expect(
      await refusal(checkForUpdate({ currentVersion: INSTALLED, policy: 'notify', release: release('0.1.9') })),
    ).toBe('downgrade');
  });

  it('refuses a pre-release of the installed version as a downgrade', async () => {
    expect(
      await refusal(checkForUpdate({ currentVersion: INSTALLED, policy: 'auto', release: release('0.2.0-rc.1') })),
    ).toBe('downgrade');
  });

  it('refuses a release below release.minimumVersion', async () => {
    expect(
      await refusal(
        checkForUpdate({ currentVersion: INSTALLED, policy: 'notify', release: release(TARGET, '0.4.0') }),
      ),
    ).toBe('below-minimum');
  });

  it('refuses a version it cannot order', async () => {
    expect(
      await refusal(checkForUpdate({ currentVersion: 'dev-build', policy: 'notify', release: release(TARGET) })),
    ).toBe('version-unreadable');
  });

  it.each([
    ['no release named', null, null, { kind: 'no-release', current: INSTALLED }],
    ['the installed one', INSTALLED, null, { kind: 'current', current: INSTALLED, target: INSTALLED }],
    ['a newer one', TARGET, null, { kind: 'available', current: INSTALLED, target: TARGET }],
    ['a newer one at the minimum', TARGET, TARGET, { kind: 'available', current: INSTALLED, target: TARGET }],
  ])('answers for %s', async (_label, version, minimum, expected) => {
    await expect(
      checkForUpdate({ currentVersion: INSTALLED, policy: 'notify', release: release(version, minimum) }),
    ).resolves.toEqual(expected);
  });
});

describe('update: the pinned identity', () => {
  it('gives gh attestation verify every identity flag, all from the binary', () => {
    expect(attestationVerifyArgs('/tmp/x.tar.gz', TARGET)).toEqual([
      'attestation',
      'verify',
      '/tmp/x.tar.gz',
      '--hostname',
      'github.com',
      '--repo',
      'geeera/team-console',
      '--signer-workflow',
      'github.com/geeera/team-console/.github/workflows/release-runner.yml',
      '--source-ref',
      'refs/tags/v0.3.0',
      '--cert-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--predicate-type',
      'https://slsa.dev/provenance/v1',
      '--deny-self-hosted-runners',
    ]);
  });

  it.each([
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['win32', 'x64', null],
    ['linux', 'ia32', null],
  ])('maps %s/%s to %s', (platform, arch, expected) => {
    expect(releasePlatformOf(platform, arch)).toBe(expected);
  });
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ExecOptions['env'];
}

type TreeFiles = Record<string, string>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function releaseTree(version: string): TreeFiles {
  const files: TreeFiles = {
    'team-console-runner.mjs': `bundle ${version}\n`,
    'bin/job-exec': '#!/bin/sh\n# job-exec\n',
    'bin/team-console-runner': '#!/bin/sh\n# launcher\n',
  };
  return {
    ...files,
    SHA256SUMS: `${Object.entries(files)
      .map(([path, text]) => `${sha256(text)}  ${path}`)
      .join('\n')}\n`,
  };
}

interface Host {
  ghMissing?: 'enoent' | 'exit';
  downloadCode?: number;
  verifyCode?: number;
  tree?: TreeFiles;
  links?: Record<string, string>;
  reportedVersion?: string;
}

describe('update: installing a release (C11 row 1)', () => {
  let parent: string;
  let home: string;
  let prefix: string;
  let calls: Call[];
  let log: string[];

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-update-'));
    home = join(parent, 'home');
    prefix = join(parent, 'prefix');
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(prefix, 'bin'), { recursive: true, mode: 0o755 });
    await writeFile(join(prefix, 'team-console-runner.mjs'), OLD_BUNDLE);
    await writeFile(join(prefix, 'bin/job-exec'), 'old job-exec\n');
    await writeFile(join(prefix, 'bin/team-console-runner'), 'old launcher\n');
    calls = [];
    log = [];
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function fakeExec(host: Host): Exec {
    return async (command, args, options): Promise<ExecResult> => {
      calls.push({ command, args: [...args], env: options?.env });
      if (command === 'gh' && args[0] === '--version') {
        if (host.ghMissing === 'enoent') {
          throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
        }
        return { code: host.ghMissing === 'exit' ? 127 : 0, stdout: 'gh version 2.101.0\n' };
      }
      if (command === 'gh' && args[0] === 'release') {
        const dir = args[args.indexOf('--dir') + 1] ?? '';
        const asset = args[args.indexOf('--pattern') + 1] ?? '';
        if ((host.downloadCode ?? 0) === 0) {
          await writeFile(join(dir, asset), 'tarball bytes');
        }
        return { code: host.downloadCode ?? 0, stdout: '' };
      }
      if (command === 'gh' && args[0] === 'attestation') {
        return { code: host.verifyCode ?? 0, stdout: '' };
      }
      if (command === 'tar') {
        const tree = args[args.indexOf('-C') + 1] ?? '';
        for (const [path, text] of Object.entries(host.tree ?? releaseTree(TARGET))) {
          await mkdir(join(tree, path, '..'), { recursive: true });
          await writeFile(join(tree, path), text, { mode: 0o555 });
        }
        for (const [path, target] of Object.entries(host.links ?? {})) {
          await symlink(target, join(tree, path));
        }
        return { code: 0, stdout: '' };
      }
      if (command === process.execPath && args[1] === 'version') {
        return { code: 0, stdout: `${host.reportedVersion ?? TARGET}\n` };
      }
      throw new Error(`unexpected command ${command} ${args.join(' ')}`);
    };
  }

  function depsOf(host: Host, overrides: Partial<ApplyDeps> = {}): ApplyDeps {
    return {
      home,
      prefix,
      platform: 'darwin',
      arch: 'arm64',
      node: process.execPath,
      exec: fakeExec(host),
      ghEnv: { PATH: '/usr/bin:/bin', HOME: home },
      uid: process.getuid?.() ?? null,
      log: (line) => log.push(line),
      ...overrides,
    };
  }

  const installedBundle = async (): Promise<string> => await readFile(join(prefix, 'team-console-runner.mjs'), 'utf8');
  const stagingLeft = async (): Promise<string[]> => await readdir(join(home, 'updates')).catch(() => []);
  /** Each call as `command` plus its leading flags, without the run's temp paths. */
  const commands = (): string[] =>
    calls.map((call) => [call.command, ...call.args.filter((arg) => !arg.startsWith(parent)).slice(0, 2)].join(' '));

  it('downloads, verifies, checks the tree and swaps the release in, bundle last', async () => {
    await applyUpdate(TARGET, depsOf({}));

    expect(await installedBundle()).toBe(`bundle ${TARGET}\n`);
    expect(await readFile(join(prefix, 'bin/job-exec'), 'utf8')).toBe('#!/bin/sh\n# job-exec\n');
    expect((await stat(join(prefix, 'team-console-runner.mjs'))).mode & 0o777).toBe(0o555);
    expect(commands()).toEqual([
      'gh --version',
      'gh release download',
      'gh attestation verify',
      'tar -xzf --no-same-owner',
      `${process.execPath} version`,
    ]);
    const download = calls[1]?.args ?? [];
    expect(download).toEqual([
      'release',
      'download',
      'v0.3.0',
      '--repo',
      'github.com/geeera/team-console',
      '--pattern',
      tarballNameOf(TARGET, 'darwin-arm64'),
      '--dir',
      download[8],
    ]);
    expect(calls[2]?.args).toEqual(attestationVerifyArgs(join(download[8] ?? '', tarballNameOf(TARGET, 'darwin-arm64')), TARGET));
    expect(calls.filter((call) => call.command === 'gh').every((call) => call.env?.['GH_HOST'] === undefined)).toBe(true);
    expect(await stagingLeft()).toEqual([]);
    expect(log.join('\n')).toContain('verified team-console-runner-0.3.0-darwin-arm64.tar.gz');
  });

  it('refuses when gh is not installed, before downloading anything', async () => {
    expect(await refusal(applyUpdate(TARGET, depsOf({ ghMissing: 'enoent' })))).toBe('gh-missing');
    expect(commands()).toEqual(['gh --version']);
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses when gh does not run', async () => {
    expect(await refusal(applyUpdate(TARGET, depsOf({ ghMissing: 'exit' })))).toBe('gh-missing');
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses when gh attestation verify fails, and never extracts the tarball', async () => {
    expect(await refusal(applyUpdate(TARGET, depsOf({ verifyCode: 1 })))).toBe('verification-failed');
    expect(calls.some((call) => call.command === 'tar')).toBe(false);
    expect(await installedBundle()).toBe(OLD_BUNDLE);
    expect(await stagingLeft()).toEqual([]);
  });

  it('refuses when the download fails', async () => {
    expect(await refusal(applyUpdate(TARGET, depsOf({ downloadCode: 1 })))).toBe('download-failed');
    expect(calls.some((call) => call.args[0] === 'attestation')).toBe(false);
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses a file that does not match SHA256SUMS', async () => {
    const tree = { ...releaseTree(TARGET), 'bin/job-exec': '#!/bin/sh\nexec evil\n' };
    expect(await refusal(applyUpdate(TARGET, depsOf({ tree })))).toBe('verification-failed');
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses a tree with an extra file', async () => {
    const tree = { ...releaseTree(TARGET), 'bin/extra': 'x' };
    expect(await refusal(applyUpdate(TARGET, depsOf({ tree })))).toBe('unpack-failed');
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses a tree with a symlink', async () => {
    const tree: TreeFiles = { ...releaseTree(TARGET) };
    delete tree['bin/team-console-runner'];
    const links = { 'bin/team-console-runner': '/etc/passwd' };
    expect(await refusal(applyUpdate(TARGET, depsOf({ tree, links })))).toBe('unpack-failed');
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses a bundle that reports another version than the release it came from', async () => {
    expect(await refusal(applyUpdate(TARGET, depsOf({ reportedVersion: '9.9.9' })))).toBe('verification-failed');
    expect(await installedBundle()).toBe(OLD_BUNDLE);
  });

  it('refuses an install directory this user does not own, before downloading', async () => {
    const uid = (process.getuid?.() ?? 0) + 1;
    expect(await refusal(applyUpdate(TARGET, depsOf({}, { uid })))).toBe('prefix-not-writable');
    expect(commands()).toEqual(['gh --version']);
  });

  it('refuses a platform no release is published for', async () => {
    expect(await refusal(applyUpdate(TARGET, depsOf({}, { platform: 'win32', arch: 'x64' })))).toBe(
      'platform-unsupported',
    );
    expect(calls).toEqual([]);
  });

  it('lists exactly the release files in a well-formed tree', () => {
    expect(Object.keys(releaseTree(TARGET)).sort()).toEqual([...RELEASE_FILES, 'SHA256SUMS'].sort());
  });

  describe('policy auto', () => {
    const at = (ms: number) => () => new Date(Date.UTC(2026, 10, 14) + ms);

    it.each(['off', 'notify'] as const)('makes no request with %s', async (policy) => {
      const answer = release(TARGET);
      const update = autoUpdater({
        policy,
        check: { currentVersion: INSTALLED, release: answer },
        apply: depsOf({}),
        now: at(0),
        log: (line) => log.push(line),
      });
      expect(await update()).toBe(false);
      expect(answer).not.toHaveBeenCalled();
    });

    it('installs a verified release and asks the loop to stop', async () => {
      const update = autoUpdater({
        policy: 'auto',
        check: { currentVersion: INSTALLED, release: release(TARGET) },
        apply: depsOf({}),
        now: at(0),
        log: (line) => log.push(line),
      });
      expect(await update()).toBe(true);
      expect(await installedBundle()).toBe(`bundle ${TARGET}\n`);
    });

    it('logs a refusal, keeps the installed version and waits an interval before asking again', async () => {
      let clock = 0;
      const answer = release(TARGET);
      const update = autoUpdater({
        policy: 'auto',
        check: { currentVersion: INSTALLED, release: answer },
        apply: depsOf({ verifyCode: 1 }),
        now: () => at(clock)(),
        log: (line) => log.push(line),
      });
      expect(await update()).toBe(false);
      expect(log.join('\n')).toContain('auto-update skipped: gh attestation verify refused');
      expect(await installedBundle()).toBe(OLD_BUNDLE);

      clock = AUTO_UPDATE_INTERVAL_MS - 1;
      expect(await update()).toBe(false);
      expect(answer).toHaveBeenCalledTimes(1);
      clock = AUTO_UPDATE_INTERVAL_MS;
      await update();
      expect(answer).toHaveBeenCalledTimes(2);
    });
  });
});
