import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_FILES, attestationVerifyArgs, releasePlatformOf, tarballNameOf, type RunnerReleaseDto } from '@shared/contracts';
import type { Exec, ExecOptions, ExecResult } from '../host/exec';
import { AUTO_UPDATE_INTERVAL_MS, autoUpdater } from './auto-update';
import { installRootOf } from './install-layout';
import {
  UpdateError,
  applyUpdate,
  checkForUpdate,
  isChannelMismatch,
  type ApplyDeps,
  type UpdateProblem,
} from './update';

// Lets a spec cut the layout conversion short: the Nth `rename` after `crash.at` is armed throws instead of running.
const crash = vi.hoisted(() => ({ at: null as number | null, renames: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: async (from: string, to: string): Promise<void> => {
      crash.renames += 1;
      if (crash.at === crash.renames) {
        throw new Error(`simulated crash before rename #${String(crash.renames)}`);
      }
      await original.rename(from, to);
    },
  };
});

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

  it('downloads, verifies, checks the tree and switches the prefix to the release', async () => {
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

  describe('the switch (#604: one rename, never a mixed install)', () => {
    const NEXT = '0.4.0';
    const nextRelease = { tree: releaseTree(NEXT), reportedVersion: NEXT };
    const link = async (name: string): Promise<string> => await readlink(join(prefix, name));
    const leftovers = async (): Promise<string[]> =>
      [...(await readdir(prefix)), ...(await readdir(join(prefix, 'releases')))].filter((name) =>
        /\.(next|flat|partial)$/.test(name),
      );

    it('converts a flat prefix: the release in its own directory, current naming it, the entries linked through it', async () => {
      await applyUpdate(TARGET, depsOf({}));

      expect(await link('current')).toBe('releases/0.3.0');
      expect((await lstat(join(prefix, 'bin'))).isDirectory()).toBe(true);
      expect(await link('bin/job-exec')).toBe('../current/bin/job-exec');
      expect(await link('bin/team-console-runner')).toBe('../current/bin/team-console-runner');
      expect(await link('team-console-runner.mjs')).toBe('current/team-console-runner.mjs');
      expect(await link('SHA256SUMS')).toBe('current/SHA256SUMS');
      expect(await readFile(join(prefix, 'SHA256SUMS'), 'utf8')).toBe(releaseTree(TARGET)['SHA256SUMS']);
      expect(await readdir(join(prefix, 'releases'))).toEqual([TARGET]);
      expect((await lstat(join(prefix, 'releases', TARGET, 'bin/job-exec'))).isFile()).toBe(true);
      expect(await readFile(join(prefix, 'bin/team-console-runner'), 'utf8')).toBe('#!/bin/sh\n# launcher\n');
      expect(await leftovers()).toEqual([]);
    });

    it('switches a converted prefix by renaming current alone, keeping the release it replaced', async () => {
      await applyUpdate(TARGET, depsOf({}));
      await mkdir(join(prefix, 'releases', '0.1.0'));

      await applyUpdate(NEXT, depsOf(nextRelease));

      expect(await link('current')).toBe('releases/0.4.0');
      expect(await installedBundle()).toBe(`bundle ${NEXT}\n`);
      expect(await readFile(join(prefix, 'releases', TARGET, 'team-console-runner.mjs'), 'utf8')).toBe(
        `bundle ${TARGET}\n`,
      );
      expect((await readdir(join(prefix, 'releases'))).sort()).toEqual([TARGET, NEXT]);
      expect(await leftovers()).toEqual([]);
    });

    it('leaves the live release whole after an interrupted switch, and the next update clears what it left', async () => {
      await applyUpdate(TARGET, depsOf({}));
      // What a crash before the rename of `current` leaves: a half-copied release and an unused link.
      await mkdir(join(prefix, 'releases', `${NEXT}.partial`, 'bin'), { recursive: true });
      await writeFile(join(prefix, 'releases', `${NEXT}.partial`, 'team-console-runner.mjs'), 'half');
      await symlink(`releases/${NEXT}.partial`, join(prefix, 'current.next'));

      expect(await installedBundle()).toBe(`bundle ${TARGET}\n`);
      expect(await readFile(join(prefix, 'bin/job-exec'), 'utf8')).toBe('#!/bin/sh\n# job-exec\n');

      await applyUpdate(NEXT, depsOf(nextRelease));
      expect(await installedBundle()).toBe(`bundle ${NEXT}\n`);
      expect((await readdir(join(prefix, 'releases'))).sort()).toEqual([TARGET, NEXT]);
      expect(await leftovers()).toEqual([]);
    });

    it('finishes a conversion an earlier layout cut short between moving bin aside and linking it', async () => {
      await applyUpdate(TARGET, depsOf({}));
      await rm(join(prefix, 'bin'), { recursive: true });
      await mkdir(join(prefix, 'bin.flat'));

      await applyUpdate(NEXT, depsOf(nextRelease));
      expect(await link('bin/job-exec')).toBe('../current/bin/job-exec');
      expect(await readFile(join(prefix, 'bin/job-exec'), 'utf8')).toBe('#!/bin/sh\n# job-exec\n');
      expect(await leftovers()).toEqual([]);
    });

    it('leaves a prefix whose bin is one link through current (the first layout) as it is', async () => {
      await applyUpdate(TARGET, depsOf({}));
      await rm(join(prefix, 'bin'), { recursive: true });
      await symlink('current/bin', join(prefix, 'bin'));

      await applyUpdate(NEXT, depsOf(nextRelease));
      expect(await link('bin')).toBe('current/bin');
      expect(await readFile(join(prefix, 'bin/job-exec'), 'utf8')).toBe('#!/bin/sh\n# job-exec\n');
    });

    describe('a crash at every step of converting a flat prefix (#666)', () => {
      afterEach(() => {
        crash.at = null;
      });

      // Renames of one conversion, in order: release into place, current, SHA256SUMS, bin/job-exec,
      // bin/team-console-runner, the bundle.
      const STEPS = 6;

      it.each(Array.from({ length: STEPS }, (_, index) => index + 1))(
        'before rename #%i: the prefix still runs, and the next update finishes it',
        async (step) => {
          crash.renames = 0;
          crash.at = step;
          await expect(applyUpdate(TARGET, depsOf({}))).rejects.toThrow(/simulated crash/);
          crash.at = null;

          // What the service needs, at the crash: the bundle, the launcher and job-exec all exist and are files.
          for (const path of ['team-console-runner.mjs', 'bin/job-exec', 'bin/team-console-runner']) {
            expect((await stat(join(prefix, path))).isFile()).toBe(true);
          }

          await applyUpdate(TARGET, depsOf({}));

          expect(await installedBundle()).toBe(`bundle ${TARGET}\n`);
          expect(await link('current')).toBe('releases/0.3.0');
          expect(await link('team-console-runner.mjs')).toBe('current/team-console-runner.mjs');
          expect(await link('SHA256SUMS')).toBe('current/SHA256SUMS');
          expect(await link('bin/job-exec')).toBe('../current/bin/job-exec');
          expect(await link('bin/team-console-runner')).toBe('../current/bin/team-console-runner');
          expect(await readFile(join(prefix, 'bin/job-exec'), 'utf8')).toBe('#!/bin/sh\n# job-exec\n');
          expect(await readdir(join(prefix, 'releases'))).toEqual([TARGET]);
          expect(await readdir(join(prefix, 'bin'))).toEqual(['job-exec', 'team-console-runner']);
          expect(await leftovers()).toEqual([]);
        },
      );

      it('still refuses to reinstall the live release once its layout is complete', async () => {
        await applyUpdate(TARGET, depsOf({}));
        expect(await refusal(applyUpdate(TARGET, depsOf({})))).toBe('unpack-failed');
      });
    });

    it('refuses a prefix whose current is not a link, before downloading', async () => {
      await mkdir(join(prefix, 'current'));
      expect(await refusal(applyUpdate(TARGET, depsOf({})))).toBe('prefix-not-writable');
      expect(commands()).toEqual(['gh --version']);
      expect(await installedBundle()).toBe(OLD_BUNDLE);
    });

    it('refuses a target that is not a version, before running anything', async () => {
      expect(await refusal(applyUpdate('../escape', depsOf({})))).toBe('version-unreadable');
      expect(calls).toEqual([]);
    });

    it('maps the running bundle back to the prefix only in a converted one', async () => {
      await applyUpdate(TARGET, depsOf({}));
      expect(installRootOf(join(prefix, 'releases', TARGET))).toBe(prefix);
      expect(installRootOf(prefix)).toBe(prefix);
      const flat = join(parent, 'releases', '1.0.0');
      expect(installRootOf(flat)).toBe(flat);
    });
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

    it('treats an installed version that is not SemVer as stable and refuses a pre-release (#666)', () => {
      expect(isChannelMismatch('dev-build', '0.3.0-rc.1')).toBe(true);
      expect(isChannelMismatch('dev-build', 'not-semver')).toBe(true);
      expect(isChannelMismatch('dev-build', TARGET)).toBe(false);
      expect(isChannelMismatch(INSTALLED, '0.3.0-rc.1')).toBe(true);
      expect(isChannelMismatch(INSTALLED, TARGET)).toBe(false);
      expect(isChannelMismatch('0.3.0-rc.1', '0.3.0-rc.2')).toBe(false);
      expect(isChannelMismatch('0.3.0-rc.1', TARGET)).toBe(false);
    });

    it('refuses a pre-release when the installed version is on the stable channel (#604)', async () => {
      const update = autoUpdater({
        policy: 'auto',
        check: { currentVersion: INSTALLED, release: release('0.3.0-rc.1') },
        apply: depsOf({}),
        now: at(0),
        log: (line) => log.push(line),
      });
      expect(await update()).toBe(false);
      expect(log.join('\n')).toContain('auto-update skipped: the console names the pre-release 0.3.0-rc.1');
      expect(calls).toEqual([]);
      expect(await installedBundle()).toBe(OLD_BUNDLE);
    });

    it.each([
      ['a later pre-release', '0.3.0-rc.1', '0.3.0-rc.2'],
      ['its stable release', '0.3.0-rc.1', '0.3.0'],
    ])('moves a pre-release runner onto %s', async (_label, current, target) => {
      const update = autoUpdater({
        policy: 'auto',
        check: { currentVersion: current, release: release(target) },
        apply: depsOf({ tree: releaseTree(target), reportedVersion: target }),
        now: at(0),
        log: (line) => log.push(line),
      });
      expect(await update()).toBe(true);
      expect(await installedBundle()).toBe(`bundle ${target}\n`);
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
