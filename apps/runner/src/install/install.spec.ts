import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

/** `path` as a root-owned file and every directory above it as root-owned, writable by root only. */
const rootChain = (path: string): Record<string, PathFacts> => {
  const stats: Record<string, PathFacts> = { [path]: ROOT_FILE };
  for (let dir = path.slice(0, path.lastIndexOf('/')) || '/'; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    stats[dir] = ROOT_DIR;
    if (dir === '/') {
      return stats;
    }
  }
};

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
    /** `null` removes a path the default host has. */
    stats?: Record<string, PathFacts | null>;
    files?: Record<string, string>;
    exec?: Record<string, ExecResult>;
    failOn?: number;
    /** Where a path leads once its links are resolved; a path not listed leads to itself. */
    realpaths?: Record<string, string | null>;
    realpath?: InstallHost['realpath'];
    /** ACE lines `ls -lde` lists under a path (macOS); a path not listed has none. */
    acls?: Record<string, string[]>;
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
    const path = args[1];
    if (command === '/bin/ls' && args[0] === '-lde' && path !== undefined) {
      return { code: 0, stdout: [`drwxr-xr-x  2 root  wheel  64 Nov 22 00:00 ${path}`, ...(overrides.acls?.[path] ?? [])].join('\n') };
    }
    return answers[line] ?? { code: 1, stdout: '' };
  };
  const stats: Record<string, PathFacts | null> = {
    // The release's own node, as a root extraction leaves it; the specs about its owner say otherwise.
    ...rootChain(NODE),
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
    realpath:
      overrides.realpath ??
      (async (path) => (overrides.realpaths !== undefined && path in overrides.realpaths ? (overrides.realpaths[path] ?? null) : path)),
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
    // Hosts queries only: dscl lists, `ls -lde` for the release's ACLs (#894), and nothing that changes the machine.
    expect(
      host.queries.every((query) => query.startsWith('/usr/bin/dscl . -list') || query.startsWith('/bin/ls -lde ')),
    ).toBe(true);
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

/**
 * S2 of the #634 security note (PR 5): the LaunchDaemon runs the release's own `<prefix>/node`, root-owned, whatever
 * node install was started with, so the login user cannot become `_tcrunner` by replacing it.
 */
describe('install --backend user: the node the daemon runs', () => {
  const OPT = '/opt/homebrew/opt/node/bin/node';
  const plistOf = (steps: readonly InstallStep[]): string => {
    const write = steps.find(
      (step) => step.kind === 'write' && step.path === '/Library/LaunchDaemons/com.team-console.runner.plist',
    );
    return write?.kind === 'write' ? write.content : '';
  };

  it.each([OPT, '/usr/local/bin/node', NODE])('names <prefix>/node when install was started with %s', async (given) => {
    const { steps, next } = await planInstall({ ...userOptions(), node: given }, fakeHost());
    const plist = plistOf(steps);
    expect(plist).toBe(launchDaemonPlist(DOCUMENTED_DEFAULTS));
    expect(plist).toContain('<string>/usr/local/lib/team-console-runner/node</string>');
    // No user-writable directory on the runner process's PATH: Homebrew's belongs to the login user.
    expect(plist).toContain('<key>PATH</key><string>/usr/local/lib/team-console-runner:/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(plist).not.toContain('/opt/homebrew');
    expect(next[0]).toContain(`${NODE} /usr/local/lib/team-console-runner/team-console-runner.mjs enrol`);
  });

  it('refuses a prefix without node (a release older than the bundled node), before any step', async () => {
    const host = fakeHost({ stats: { [NODE]: null } });
    await expect(runInstall(userOptions(true), host, () => undefined)).rejects.toThrow(
      `${NODE} must exist, be root-owned and writable by root only`,
    );
    expect(host.applied).toEqual([]);
  });

  it.each([
    ['owned by the login user', { uid: 501, mode: 0o555, kind: 'file' }],
    ['writable by the group', { uid: 0, mode: 0o575, kind: 'file' }],
  ] as const)('refuses a node %s', async (_, facts) => {
    await expect(planInstall(userOptions(), fakeHost({ stats: { [NODE]: facts } }))).rejects.toThrow(
      `${NODE} must exist, be root-owned`,
    );
  });

  it('accepts the link update leaves through current when its target and directory are root-owned', async () => {
    const target = `${PREFIX}/releases/0.2.0/node`;
    const host = fakeHost({
      realpaths: { [NODE]: target },
      stats: { [NODE]: { uid: 0, mode: 0o755, kind: 'symlink' }, [target]: ROOT_FILE, [`${PREFIX}/releases/0.2.0`]: ROOT_DIR },
    });
    expect(plistOf((await planInstall(userOptions(), host)).steps)).toContain(`<string>${NODE}</string>`);
  });

  it.each([
    ['a target the login user owns', { uid: 501, mode: 0o555, kind: 'file' }, ROOT_DIR],
    ['a target in a directory others can write', ROOT_FILE, { uid: 0, mode: 0o777, kind: 'directory' }],
  ] as const)('refuses a root-owned link to %s', async (_, targetFacts, dirFacts) => {
    const target = '/opt/somewhere/node';
    const host = fakeHost({
      realpaths: { [NODE]: target },
      stats: { [NODE]: { uid: 0, mode: 0o755, kind: 'symlink' }, [target]: targetFacts, '/opt/somewhere': dirFacts },
    });
    await expect(planInstall(userOptions(), host)).rejects.toThrow(/must exist, be root-owned and writable by root only/);
  });
});

/** #884: `releases/` and the release `current` names are root's alone too, or whoever owns them swaps every link. */
describe('install --backend user: the layout update leaves', () => {
  const RELEASES = `${PREFIX}/releases`;
  const CURRENT = `${PREFIX}/current`;
  const RELEASE = `${RELEASES}/0.2.0`;
  const ROOT_LINK: PathFacts = { uid: 0, mode: 0o755, kind: 'symlink' };
  const layout = (
    stats: Record<string, PathFacts | null> = {},
    realpaths: Record<string, string | null> = {},
  ): FakeHost =>
    fakeHost({
      stats: { [RELEASES]: ROOT_DIR, [CURRENT]: ROOT_LINK, [RELEASE]: ROOT_DIR, ...stats },
      realpaths: { [CURRENT]: RELEASE, ...realpaths },
    });

  it('accepts root-owned releases/ and a root-owned current naming a root-owned release', async () => {
    await expect(planInstall(userOptions(), layout())).resolves.toBeDefined();
  });

  it('accepts a flat prefix with neither', async () => {
    await expect(planInstall(userOptions(), fakeHost())).resolves.toBeDefined();
  });

  it.each([
    ['owned by the login user', { uid: 501, mode: 0o755, kind: 'directory' }],
    ['writable by the group', { uid: 0, mode: 0o775, kind: 'directory' }],
    ['not a directory', { uid: 0, mode: 0o755, kind: 'symlink' }],
  ] as const)('refuses releases/ %s', async (_, facts) => {
    await expect(planInstall(userOptions(), layout({ [RELEASES]: facts }))).rejects.toThrow(
      `${RELEASES} must exist, be root-owned and writable by root only`,
    );
  });

  it.each([
    ['owned by the login user', { uid: 501, mode: 0o755, kind: 'symlink' }],
    ['a directory rather than a link', ROOT_DIR],
  ] as const)('refuses a current %s', async (_, facts) => {
    await expect(planInstall(userOptions(), layout({ [CURRENT]: facts }))).rejects.toThrow(
      `${CURRENT} must be a root-owned link to a release under ${RELEASES}`,
    );
  });

  it('refuses a current that leads nowhere', async () => {
    await expect(planInstall(userOptions(), layout({}, { [CURRENT]: null }))).rejects.toThrow(
      `${CURRENT} must exist, be root-owned`,
    );
  });

  it.each([
    ['owned by the login user', { uid: 501, mode: 0o755, kind: 'directory' }],
    ['writable by others', { uid: 0, mode: 0o757, kind: 'directory' }],
    ['a file', ROOT_FILE],
  ] as const)('refuses a release current names that is %s', async (_, facts) => {
    await expect(planInstall(userOptions(), layout({ [RELEASE]: facts }))).rejects.toThrow(
      `${RELEASE} must exist, be root-owned and writable by root only`,
    );
  });

  // #894: the error always said "a release under releases/"; now that is enforced, whoever owns the target.
  it.each([
    ['a directory the login user owns', '/Users/kirill/releases/0.2.0'],
    ['a root-owned directory outside the prefix', '/opt/elsewhere/0.2.0'],
    ['the prefix itself', PREFIX],
    ['a directory below a release', `${RELEASE}/bin`],
  ])('refuses a current that points into %s', async (_, target) => {
    const host = layout(
      { [target]: ROOT_DIR, '/Users/kirill/releases': { uid: 501, mode: 0o755, kind: 'directory' }, '/opt/elsewhere': ROOT_DIR },
      { [CURRENT]: target },
    );
    await expect(planInstall(userOptions(), host)).rejects.toThrow(
      `${CURRENT} must be a root-owned link to a release under ${RELEASES}`,
    );
  });

  it('refuses a current when there is no releases/', async () => {
    await expect(planInstall(userOptions(), layout({ [RELEASES]: null }))).rejects.toThrow(
      `${CURRENT} must be a root-owned link to a release under ${RELEASES}`,
    );
  });

  it('compares physical paths, so a prefix under a link still has its release under releases/', async () => {
    const physical = `/private${RELEASES}`;
    const host = layout({ [`${physical}/0.2.0`]: ROOT_DIR, [physical]: ROOT_DIR }, {
      [CURRENT]: `${physical}/0.2.0`,
      [RELEASES]: physical,
    });
    await expect(planInstall(userOptions(), host)).resolves.toBeDefined();
  });
});

/** #894: Node's lstat cannot see ACLs, so on macOS install asks `ls -lde`; `chmod +a` leaves the mode alone. */
describe('install --backend user: macOS ACLs on the release', () => {
  const JOB_EXEC = `${PREFIX}/bin/job-exec`;

  it.each([
    ['bin/job-exec, which the sudoers rule hands out', JOB_EXEC, ' 0: user:kirill allow write,append'],
    ['bin/', `${PREFIX}/bin`, ' 0: group:staff allow add_file,delete_child'],
    ['the prefix', PREFIX, ' 0: group:everyone inherited allow delete'],
    ['the bundle', `${PREFIX}/team-console-runner.mjs`, ' 0: user:kirill allow chown'],
  ])('refuses an entry on %s that lets someone else write', async (_, path, ace) => {
    await expect(planInstall(userOptions(), fakeHost({ acls: { [path]: [ace] } }))).rejects.toThrow(
      `${path} must exist, be root-owned and writable by root only (on macOS, no ACL entry that lets anyone else write)`,
    );
  });

  it('refuses a job-exec link whose target carries such an entry', async () => {
    const target = `${PREFIX}/releases/0.2.0/bin/job-exec`;
    const host = fakeHost({
      realpaths: { [JOB_EXEC]: target },
      stats: { [JOB_EXEC]: { uid: 0, mode: 0o755, kind: 'symlink' }, [target]: ROOT_FILE, [`${PREFIX}/releases/0.2.0/bin`]: ROOT_DIR },
      acls: { [target]: [' 0: user:kirill allow write'] },
    });
    await expect(planInstall(userOptions(), host)).rejects.toThrow(`${target} must exist, be root-owned`);
  });

  it('accepts entries that only deny, only read, or grant root', async () => {
    const host = fakeHost({
      acls: {
        [JOB_EXEC]: [' 0: group:everyone deny write,delete', ' 1: user:kirill allow read,execute', ' 2: user:root allow write'],
      },
    });
    await expect(planInstall(userOptions(), host)).resolves.toBeDefined();
    expect(host.queries).toContain(`/bin/ls -lde ${JOB_EXEC}`);
  });

  it('refuses a path it cannot list, since then it cannot tell', async () => {
    const host = fakeHost();
    const listing = host.exec;
    const failing: FakeHost = {
      ...host,
      exec: async (command, args, options) =>
        command === '/bin/ls' && args[1] === JOB_EXEC ? { code: 1, stdout: '' } : await listing(command, args, options),
    };
    await expect(planInstall(userOptions(), failing)).rejects.toThrow(`${JOB_EXEC} must exist, be root-owned`);
  });
});

/** #772: the node the container backend's service runs survives `brew upgrade node`. */
describe('install --backend container: the node the service runs', () => {
  const CELLAR = '/home/linuxbrew/.linuxbrew/Cellar/node/26.0.0/bin/node';
  const OPT = '/home/linuxbrew/.linuxbrew/opt/node/bin/node';
  const linux = (overrides: Parameters<typeof fakeHost>[0] = {}): FakeHost =>
    fakeHost({ platform: 'linux', uid: 1000, exec: { 'docker version': { code: 0, stdout: '' } }, ...overrides });
  const unitOf = (steps: readonly InstallStep[]): string => {
    const unit = steps.find((step) => step.kind === 'write');
    return unit?.kind === 'write' ? unit.content : '';
  };

  it.each([
    ['Homebrew bin link', '/home/linuxbrew/.linuxbrew/bin/node'],
    ['Cellar path itself', CELLAR],
    ['versionless opt link', OPT],
  ])('writes the versionless opt link for the %s, never the Cellar path', async (_, given) => {
    const host = linux({ realpaths: { '/home/linuxbrew/.linuxbrew/bin/node': CELLAR, [OPT]: CELLAR, [CELLAR]: CELLAR } });
    const unit = unitOf((await planInstall({ ...containerOptions(), node: given }, host)).steps);
    expect(unit).toContain(`ExecStart=${OPT} `);
    expect(unit).not.toContain('Cellar');
  });

  it('keeps a node outside Homebrew as given, not its realpath', async () => {
    const host = linux({ realpaths: { '/usr/local/bin/node': '/usr/local/lib/nodejs/node-v22/bin/node' } });
    expect(unitOf((await planInstall({ ...containerOptions(), node: '/usr/local/bin/node' }, host)).steps)).toContain(
      'ExecStart=/usr/local/bin/node ',
    );
  });

  it('refuses a Cellar node when the versionless link is missing', async () => {
    const host = linux({ realpaths: { '/home/linuxbrew/.linuxbrew/bin/node': CELLAR, [OPT]: null } });
    await expect(planInstall({ ...containerOptions(), node: '/home/linuxbrew/.linuxbrew/bin/node' }, host)).rejects.toThrow(
      `${OPT} does not exist: run brew link node`,
    );
  });

  describe('a planted Homebrew layout on disk', () => {
    let root: string;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'install-brew-')));
      await mkdir(join(root, 'Cellar/node/26.0.0/bin'), { recursive: true });
      await writeFile(join(root, 'Cellar/node/26.0.0/bin/node'), '');
      await mkdir(join(root, 'bin'));
      await mkdir(join(root, 'opt'));
      await symlink('../Cellar/node/26.0.0/bin/node', join(root, 'bin/node'));
      await symlink('../Cellar/node/26.0.0', join(root, 'opt/node'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const realHost = (): InstallHost['realpath'] =>
      systemInstallHost({ platform: 'linux', uid: 1000, homeDir: '/nonexistent', exec: async () => ({ code: 1, stdout: '' }) })
        .realpath;

    it('the unit names opt/node, which still resolves after brew upgrade swaps the keg', async () => {
      const unit = unitOf((await planInstall({ ...containerOptions(), node: join(root, 'bin/node') }, linux({ realpath: realHost() }))).steps);
      expect(unit).toContain(`ExecStart=${join(root, 'opt/node/bin/node')} `);
      expect(unit).not.toContain('Cellar');

      // What `brew upgrade node` does: a new keg, the links repointed, the old keg gone.
      await mkdir(join(root, 'Cellar/node/26.1.0/bin'), { recursive: true });
      await writeFile(join(root, 'Cellar/node/26.1.0/bin/node'), '');
      await rm(join(root, 'opt/node'));
      await symlink('../Cellar/node/26.1.0', join(root, 'opt/node'));
      await rm(join(root, 'Cellar/node/26.0.0'), { recursive: true });
      expect(await realHost()(join(root, 'opt/node/bin/node'))).toBe(join(root, 'Cellar/node/26.1.0/bin/node'));
    });

    it('refuses when opt/node is missing', async () => {
      await rm(join(root, 'opt/node'));
      await expect(
        planInstall({ ...containerOptions(), node: join(root, 'bin/node') }, linux({ realpath: realHost() })),
      ).rejects.toThrow(/inside Homebrew's Cellar, which brew upgrade replaces/);
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
