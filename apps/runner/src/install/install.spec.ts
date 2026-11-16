import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedSettingsText } from '../backends/user';
import type { Exec, ExecResult } from '../host/exec';
import {
  InstallError,
  assertAllowedPaths,
  describeStep,
  planInstall,
  runInstall,
  systemInstallHost,
  type InstallHost,
  type InstallOptions,
  type InstallStep,
  type PathFacts,
} from './install';
import { DOCUMENTED_DEFAULTS, launchDaemonPlist, sudoersRule, systemdUnit } from './templates';

/**
 * Threat model C11 "the installer escalates" (ADR 0008 decision 11) through a fake host — the real installer never
 * runs on a developer machine: the exact command list, nothing written outside decision 11's paths, every
 * privileged write behind `--yes` and listed by `--dry-run`, idempotent, and every refusal.
 */

const PREFIX = DOCUMENTED_DEFAULTS.prefix;
const NODE = DOCUMENTED_DEFAULTS.node;
const SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json';
const ROOT_DIR: PathFacts = { uid: 0, mode: 0o755, kind: 'directory' };
const ROOT_FILE: PathFacts = { uid: 0, mode: 0o555, kind: 'file' };
const IMAGE = `ghcr.io/geeera/team-console-runner:0.1.0@sha256:${'b'.repeat(64)}`;

interface FakeHost extends InstallHost {
  readonly applied: InstallStep[];
  readonly queries: string[];
}

function fakeHost(
  overrides: {
    platform?: string;
    uid?: number;
    users?: string;
    groups?: string;
    stats?: Record<string, PathFacts>;
    files?: Record<string, string>;
    exec?: Record<string, ExecResult>;
    failOn?: number;
  } = {},
): FakeHost {
  const applied: InstallStep[] = [];
  const queries: string[] = [];
  const answers: Record<string, ExecResult> = {
    '/usr/bin/dscl . -list /Users UniqueID': {
      code: 0,
      stdout: overrides.users ?? 'root 0\n_www 70\nkirill 501\nfoo 400\n',
    },
    '/usr/bin/dscl . -list /Groups PrimaryGroupID': {
      code: 0,
      stdout: overrides.groups ?? 'wheel 0\nstaff 20\nbar 401\n',
    },
    ...overrides.exec,
  };
  const exec: Exec = async (command, args) => {
    const line = [command, ...args].join(' ');
    queries.push(line);
    return answers[line] ?? { code: 1, stdout: '' };
  };
  const stats: Record<string, PathFacts> = {
    [PREFIX]: ROOT_DIR,
    [`${PREFIX}/bin`]: ROOT_DIR,
    [`${PREFIX}/team-console-runner.mjs`]: ROOT_FILE,
    [`${PREFIX}/bin/job-exec`]: ROOT_FILE,
    ...overrides.stats,
  };
  return {
    platform: overrides.platform ?? 'darwin',
    uid: overrides.uid ?? 0,
    homeDir: '/Users/kirill',
    exec,
    applied,
    queries,
    stat: async (path) => stats[path] ?? null,
    read: async (path) => overrides.files?.[path] ?? null,
    apply: async (step) => {
      if (applied.length + 1 === overrides.failOn) {
        throw new Error('boom');
      }
      applied.push(step);
    },
  };
}

const userOptions = (apply = false): InstallOptions => ({
  backend: 'user',
  apply,
  prefix: PREFIX,
  node: NODE,
});
const containerOptions = (overrides: Partial<InstallOptions> = {}): InstallOptions => ({
  backend: 'container',
  apply: false,
  prefix: '/home/me/team-console-runner',
  node: '/usr/bin/node',
  image: IMAGE,
  ...overrides,
});

const dscl = (user: string, attribute: string, value: string): string =>
  `/usr/bin/dscl . -create /Users/${user} ${attribute} ${value}`;

describe('install --backend user (macOS)', () => {
  it('plans exactly these commands on a fresh Mac', async () => {
    const plan = await planInstall(userOptions(), fakeHost());
    expect(plan.steps.map(describeStep)).toEqual([
      "/usr/sbin/dseditgroup -o create -i 402 -r 'team-console job' _tcjob",
      '/usr/bin/dscl . -create /Users/_tcjob',
      dscl('_tcjob', 'UniqueID', '403'),
      dscl('_tcjob', 'PrimaryGroupID', '402'),
      dscl('_tcjob', 'UserShell', '/usr/bin/false'),
      dscl('_tcjob', 'NFSHomeDirectory', '/var/empty'),
      dscl('_tcjob', 'RealName', "'team-console job'"),
      dscl('_tcjob', 'IsHidden', '1'),
      dscl('_tcjob', 'Password', "'*'"),
      '/usr/bin/dscl . -create /Users/_tcrunner',
      dscl('_tcrunner', 'UniqueID', '404'),
      dscl('_tcrunner', 'PrimaryGroupID', '402'),
      dscl('_tcrunner', 'UserShell', '/usr/bin/false'),
      dscl('_tcrunner', 'NFSHomeDirectory', '/Users/_tcrunner'),
      dscl('_tcrunner', 'RealName', "'team-console runner'"),
      dscl('_tcrunner', 'IsHidden', '1'),
      dscl('_tcrunner', 'Password', "'*'"),
      'mkdir -m 0710 /Users/_tcrunner && chown _tcrunner:_tcjob /Users/_tcrunner',
      'mkdir -m 0700 /Users/_tcrunner/credentials && chown _tcrunner:_tcjob /Users/_tcrunner/credentials',
      'mkdir -m 0700 /Users/_tcrunner/logs && chown _tcrunner:_tcjob /Users/_tcrunner/logs',
      "mkdir -m 0755 '/Library/Application Support/ClaudeCode' && chown root:wheel '/Library/Application Support/ClaudeCode'",
      `write '${SETTINGS}' (0644 root:wheel, ${String(managedSettingsText().length)} bytes)`,
      '/usr/sbin/visudo -c -f - < (the file below)',
      `write /etc/sudoers.d/team-console-runner (0440 root:wheel, ${String(sudoersRule(PREFIX).length)} bytes)`,
      `write /Library/LaunchDaemons/com.team-console.runner.plist (0644 root:wheel, ${String(
        launchDaemonPlist(DOCUMENTED_DEFAULTS).length,
      )} bytes)`,
    ]);
  });

  it('writes the managed settings root-owned, the one sudoers rule (checked first) and the daemon', async () => {
    const { steps } = await planInstall(userOptions(), fakeHost());
    const writes = steps.filter((step) => step.kind === 'write');
    expect(writes.map((step) => [step.path, step.mode, step.owner])).toEqual([
      [SETTINGS, 0o644, 'root:wheel'],
      ['/etc/sudoers.d/team-console-runner', 0o440, 'root:wheel'],
      ['/Library/LaunchDaemons/com.team-console.runner.plist', 0o644, 'root:wheel'],
    ]);
    expect(writes[0]?.content).toBe(managedSettingsText());
    const sudoers = writes[1]?.content ?? '';
    expect(sudoers.split('\n').filter((line) => line.includes('NOPASSWD'))).toEqual([
      '_tcrunner ALL=(_tcjob) NOPASSWD: /usr/local/lib/team-console-runner/bin/job-exec',
    ]);
    const visudo = steps.find((step) => step.kind === 'run' && step.command === '/usr/sbin/visudo');
    expect(visudo).toMatchObject({ stdin: sudoers });
    expect(steps.indexOf(visudo as InstallStep)).toBe(steps.indexOf(writes[1] as InstallStep) - 1);
  });

  it('writes nothing outside TC_RUNNER_HOME, the plist, the sudoers file and the managed-settings path', async () => {
    const { steps } = await planInstall({ ...userOptions(), home: '/opt/tc' }, fakeHost());
    const allowed = [
      /^\/opt\/tc(\/|$)/,
      /^\/Library\/LaunchDaemons\/com\.team-console\.runner\.plist$/,
      /^\/etc\/sudoers\.d\/team-console-runner$/,
      /^\/Library\/Application Support\/ClaudeCode(\/managed-settings\.json)?$/,
    ];
    for (const step of steps) {
      if (step.kind !== 'run') {
        expect(
          allowed.some((pattern) => pattern.test(step.path)),
          step.path,
        ).toBe(true);
      }
    }
    expect(() =>
      assertAllowedPaths(userOptions(), fakeHost(), {
        steps: [{ kind: 'write', path: '/etc/pam.d/sudo', mode: 0o644, content: '' }],
        next: [],
      }),
    ).toThrow(/outside what the installer may touch/);
  });

  it('is idempotent: nothing to do when everything is in place', async () => {
    const files = {
      [SETTINGS]: managedSettingsText(),
      '/etc/sudoers.d/team-console-runner': sudoersRule(PREFIX),
      '/Library/LaunchDaemons/com.team-console.runner.plist': launchDaemonPlist(DOCUMENTED_DEFAULTS),
    };
    const host = fakeHost({
      users: 'root 0\n_tcjob 403\n_tcrunner 404\n',
      groups: 'wheel 0\n_tcjob 402\n',
      stats: {
        '/Users/_tcrunner': { uid: 404, mode: 0o710, kind: 'directory' },
        '/Users/_tcrunner/credentials': { uid: 404, mode: 0o700, kind: 'directory' },
        '/Users/_tcrunner/logs': { uid: 404, mode: 0o700, kind: 'directory' },
        '/Library/Application Support/ClaudeCode': { uid: 0, mode: 0o755, kind: 'directory' },
        [SETTINGS]: { uid: 0, mode: 0o644, kind: 'file' },
        '/etc/sudoers.d/team-console-runner': { uid: 0, mode: 0o440, kind: 'file' },
        '/Library/LaunchDaemons/com.team-console.runner.plist': { uid: 0, mode: 0o644, kind: 'file' },
      },
      files,
    });
    const lines: string[] = [];
    const plan = await runInstall(userOptions(true), host, (line) => lines.push(line));
    expect(plan.steps).toEqual([]);
    expect(lines[0]).toBe('Already installed: nothing to change.');
    expect(host.queries).toContain('/usr/sbin/dseditgroup -o checkmember -m _tcjob admin');
  });

  it('rewrites a managed-settings file someone changed or chowned', async () => {
    const host = fakeHost({
      stats: { [SETTINGS]: { uid: 501, mode: 0o644, kind: 'file' } },
      files: { [SETTINGS]: managedSettingsText() },
    });
    const { steps } = await planInstall(userOptions(), host);
    expect(steps.some((step) => step.kind === 'write' && step.path === SETTINGS)).toBe(true);
  });

  it('--dry-run lists every step and changes nothing', async () => {
    const host = fakeHost({ uid: 501 });
    const lines: string[] = [];
    const plan = await runInstall(userOptions(false), host, (line) => lines.push(line));
    expect(host.applied).toEqual([]);
    expect(lines[0]).toBe(
      `Dry run, nothing changed. With --yes these ${String(plan.steps.length)} steps run as root:`,
    );
    expect(lines.slice(1, plan.steps.length + 1)).toEqual(
      plan.steps.map((step, at) => `  ${String(at + 1)}. ${describeStep(step)}`),
    );
    expect(lines.join('\n')).toMatch(
      /enrol --url <console origin> --backend user --credential setup-token --code - \(paste the tce_… code/,
    );
    expect(lines.join('\n')).toMatch(/claude setup-token/);
    // Hosts queries only: dscl lists and nothing that changes the machine.
    expect(host.queries.every((query) => query.startsWith('/usr/bin/dscl . -list'))).toBe(true);
  });

  it('--yes applies the same steps in order, as root', async () => {
    const host = fakeHost();
    const plan = await runInstall(userOptions(true), host, () => undefined);
    expect(host.applied).toEqual(plan.steps);
  });

  it('stops at the first failed step', async () => {
    const host = fakeHost({ failOn: 3 });
    await expect(runInstall(userOptions(true), host, () => undefined)).rejects.toThrow(
      /step 3 failed \(boom\); later steps did not run/,
    );
    expect(host.applied).toHaveLength(2);
  });

  it('narrows a home an older release made 0750 to 0710 (#599)', async () => {
    const host = fakeHost({
      users: 'root 0\n_tcjob 403\n_tcrunner 404\n',
      groups: 'wheel 0\n_tcjob 402\n',
      stats: { '/Users/_tcrunner': { uid: 404, mode: 0o750, kind: 'directory' } },
    });
    const { steps } = await planInstall(userOptions(), host);
    expect(steps).toContainEqual({
      kind: 'mkdir',
      path: '/Users/_tcrunner',
      mode: 0o710,
      owner: '_tcrunner:_tcjob',
    });
  });

  it('has the operator run claude setup-token with umask 077 (#599)', async () => {
    const { next } = await planInstall(userOptions(), fakeHost());
    expect(next[1]).toContain(
      "sudo -u _tcrunner sh -c 'umask 077; HOME=/Users/_tcrunner exec claude setup-token'",
    );
  });

  describe('refuses', () => {
    // #598: `_tcrunner` owns its home and may plant a link to a root-owned directory where one of its own belongs.
    it.each([
      ['/Users/_tcrunner/credentials', 'symlink'],
      ['/Users/_tcrunner/logs', 'symlink'],
      ['/Users/_tcrunner/logs', 'file'],
      ['/Users/_tcrunner', 'symlink'],
    ] as const)('%s as a %s instead of a directory, before any step', async (path, kind) => {
      const host = fakeHost({ stats: { [path]: { uid: 404, mode: 0o755, kind } } });
      await expect(runInstall(userOptions(true), host, () => undefined)).rejects.toThrow(
        new RegExp(`${path} is a ${kind}, not a directory`),
      );
      expect(host.applied).toEqual([]);
    });

    it('--yes without root, before touching anything', async () => {
      const host = fakeHost({ uid: 501 });
      await expect(runInstall(userOptions(true), host, () => undefined)).rejects.toThrow(/run it with sudo/);
      expect(host.queries).toEqual([]);
    });

    it('on Linux', async () => {
      await expect(planInstall(userOptions(), fakeHost({ platform: 'linux' }))).rejects.toThrow(
        /installs on macOS/,
      );
    });

    it('a release directory others can write (the sudoers rule would hand it out)', async () => {
      const host = fakeHost({
        stats: { [`${PREFIX}/bin/job-exec`]: { uid: 501, mode: 0o755, kind: 'file' } },
      });
      await expect(planInstall(userOptions(), host)).rejects.toThrow(/must exist, be root-owned/);
      const writable = fakeHost({ stats: { [`${PREFIX}/bin`]: { uid: 0, mode: 0o775, kind: 'directory' } } });
      await expect(planInstall(userOptions(), writable)).rejects.toThrow(/writable by root only/);
    });

    it('an existing job or runner user with admin rights', async () => {
      const host = fakeHost({
        users: 'root 0\n_tcjob 403\n',
        exec: { '/usr/sbin/dseditgroup -o checkmember -m _tcjob admin': { code: 0, stdout: 'yes' } },
      });
      await expect(planInstall(userOptions(), host)).rejects.toThrow(/_tcjob exists and is an admin/);
    });

    it('a home or prefix a template could not hold safely', async () => {
      await expect(planInstall({ ...userOptions(), home: '/Users/a b' }, fakeHost())).rejects.toThrow(
        InstallError,
      );
      await expect(planInstall({ ...userOptions(), home: '/opt/../etc' }, fakeHost())).rejects.toThrow(
        InstallError,
      );
    });

    it('when no system id is free', async () => {
      const taken = Array.from({ length: 100 }, (_, at) => `u${String(at)} ${String(400 + at)}`).join('\n');
      await expect(planInstall(userOptions(), fakeHost({ users: taken }))).rejects.toThrow(/no free id/);
    });
  });
});

describe('install --backend container', () => {
  const linux = (): FakeHost =>
    fakeHost({ platform: 'linux', uid: 1000, exec: { 'docker version': { code: 0, stdout: '' } } });

  it('plans exactly these steps on Linux, as the user', async () => {
    const plan = await planInstall(containerOptions(), linux());
    expect(plan.steps.map(describeStep)).toEqual([
      `docker pull ${IMAGE}`,
      'mkdir -m 0700 /Users/kirill/.team-console-runner',
      'mkdir -m 0755 /Users/kirill/.config/systemd/user',
      `write /Users/kirill/.config/systemd/user/team-console-runner.service (0644, ${String(
        systemdUnit({
          node: '/usr/bin/node',
          prefix: '/home/me/team-console-runner',
          home: '/Users/kirill/.team-console-runner',
        }).length,
      )} bytes)`,
    ]);
    expect(plan.next.join('\n')).toMatch(/--backend container --image /);
  });

  it('uses a LaunchAgent on macOS', async () => {
    const host = fakeHost({ uid: 501, exec: { 'docker version': { code: 0, stdout: '' } } });
    const { steps } = await planInstall(containerOptions(), host);
    expect(steps.filter((step) => step.kind === 'write').map((step) => step.path)).toEqual([
      '/Users/kirill/Library/LaunchAgents/com.team-console.runner.plist',
    ]);
    expect(steps.every((step) => step.kind === 'run' || !('owner' in step) || step.owner === undefined)).toBe(
      true,
    );
  });

  describe('refuses', () => {
    it('as root', async () => {
      await expect(planInstall(containerOptions(), fakeHost({ platform: 'linux', uid: 0 }))).rejects.toThrow(
        /without sudo/,
      );
    });

    it('an image not pinned by digest', async () => {
      await expect(
        planInstall(containerOptions({ image: 'ghcr.io/x/runner:latest' }), linux()),
      ).rejects.toThrow(/pinned by digest/);
      await expect(planInstall(containerOptions({ image: undefined }), linux())).rejects.toThrow(
        /pinned by digest/,
      );
    });

    it('without a running container runtime', async () => {
      await expect(planInstall(containerOptions({ runtime: 'podman' }), linux())).rejects.toThrow(
        /podman is not installed/,
      );
    });
  });
});

/**
 * The real host's `mkdir` step (#598), against a temp directory: the mode is set through an `O_NOFOLLOW` directory
 * handle, so a symlink or a file swapped in after planning is refused and what it points to is left as it was.
 */
describe('systemInstallHost apply mkdir', () => {
  let root: string;
  const host = (): InstallHost =>
    systemInstallHost({
      platform: process.platform,
      uid: 0,
      homeDir: '/nonexistent',
      exec: async () => ({ code: 1, stdout: '' }),
    });
  const mkdirStep = (path: string, mode: number): InstallStep => ({ kind: 'mkdir', path, mode });
  const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o7777;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'install-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a missing directory with exactly the mode, past the umask', async () => {
    const path = join(root, 'home', 'logs');
    await host().apply(mkdirStep(path, 0o710));
    expect(await modeOf(path)).toBe(0o710);
  });

  it('narrows an existing directory to the mode', async () => {
    const path = join(root, 'home');
    await mkdir(path, { mode: 0o755 });
    await host().apply(mkdirStep(path, 0o710));
    expect(await modeOf(path)).toBe(0o710);
  });

  it('refuses a symlink to a directory and leaves its target alone', async () => {
    const target = join(root, 'root-owned');
    await mkdir(target);
    await chmod(target, 0o755);
    const link = join(root, 'credentials');
    await symlink(target, link);
    await expect(host().apply(mkdirStep(link, 0o700))).rejects.toThrow(
      /not a directory \(a symlink is refused too\)/,
    );
    expect(await modeOf(target)).toBe(0o755);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('refuses a regular file and leaves its mode alone', async () => {
    const file = join(root, 'logs');
    await writeFile(file, '', { mode: 0o644 });
    await expect(host().apply(mkdirStep(file, 0o700))).rejects.toThrow();
    expect(await modeOf(file)).toBe(0o644);
  });

  it('reports a symlink as one, not as its target', async () => {
    const link = join(root, 'link');
    await symlink(root, link);
    expect(await host().stat(link)).toMatchObject({ kind: 'symlink' });
    expect(await host().stat(root)).toMatchObject({ kind: 'directory' });
  });
});
