import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_USER, RUNNER_USER, SYSTEM_MANAGED_SETTINGS_PATH, managedSettingsText } from '../backends/user';
import { PINNED_IMAGE, type ContainerRuntime } from '../config/config';
import type { Exec } from '../host/exec';
import {
  LAUNCH_DAEMON_PATH,
  LAUNCH_LABEL,
  SAFE_PATH,
  SUDOERS_PATH,
  SYSTEMD_UNIT_NAME,
  bundleOf,
  jobExecOf,
  launchAgentPlist,
  launchDaemonPlist,
  sudoersRule,
  systemdUnit,
  DOCUMENTED_DEFAULTS,
} from './templates';

/**
 * `team-console-runner install` (ADR 0008 decision 11, threat model C11 "the installer escalates"): computes every
 * privileged step first, refuses one that would write outside `TC_RUNNER_HOME`, the LaunchDaemon plist, the sudoers
 * file and the managed-settings path (`container`: the home and its own service unit), lists them all with
 * `--dry-run` and runs them only with `--yes`. Idempotent: a step whose result is already in place is left out. It
 * never handles a credential or an enrolment code; it prints the steps the operator does by hand.
 */

export type InstallStep =
  | {
      readonly kind: 'run';
      readonly command: string;
      readonly args: readonly string[];
      readonly stdin?: string;
    }
  | { readonly kind: 'mkdir'; readonly path: string; readonly mode: number; readonly owner?: string }
  | {
      readonly kind: 'write';
      readonly path: string;
      readonly mode: number;
      readonly owner?: string;
      readonly content: string;
    };

export interface PathFacts {
  readonly uid: number;
  readonly mode: number;
}

/** The host as the installer sees it; the spec drives a fake and asserts the steps. */
export interface InstallHost {
  readonly platform: string;
  readonly uid: number;
  readonly homeDir: string;
  /** Read-only queries (`dscl -list`, `docker version`); every change is a step. */
  readonly exec: Exec;
  stat(path: string): Promise<PathFacts | null>;
  read(path: string): Promise<string | null>;
  apply(step: InstallStep): Promise<void>;
}

export interface InstallOptions {
  readonly backend: 'user' | 'container';
  readonly apply: boolean;
  /** Where the release was extracted: `team-console-runner.mjs` and `bin/job-exec`. */
  readonly prefix: string;
  readonly node: string;
  readonly home?: string | undefined;
  readonly image?: string | undefined;
  readonly runtime?: ContainerRuntime | undefined;
}

export interface InstallPlan {
  readonly steps: readonly InstallStep[];
  /** What the operator does by hand afterwards. */
  readonly next: readonly string[];
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

const DSCL = '/usr/bin/dscl';
const DSEDITGROUP = '/usr/sbin/dseditgroup';
const ID_RANGE = { from: 400, to: 499 } as const;
const ROOT_OWNER = 'root:wheel';
const managedSettingsDirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

function assertSafePath(label: string, path: string): void {
  if (!SAFE_PATH.test(path) || path.split('/').includes('..')) {
    throw new InstallError(
      `${label} must be an absolute path of letters, digits, ".", "_", "-" and "/" (${path})`,
    );
  }
}

/** `name id` lines of `dscl . -list /Users UniqueID`. */
function parseIdList(output: string): Map<string, number> {
  const ids = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(-?\d+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      ids.set(match[1], Number(match[2]));
    }
  }
  return ids;
}

async function listIds(host: InstallHost, kind: 'Users' | 'Groups'): Promise<Map<string, number>> {
  const { code, stdout } = await host.exec(DSCL, [
    '.',
    '-list',
    `/${kind}`,
    kind === 'Users' ? 'UniqueID' : 'PrimaryGroupID',
  ]);
  if (code !== 0) {
    throw new InstallError(`dscl could not list ${kind.toLowerCase()}`);
  }
  return parseIdList(stdout);
}

async function needsWrite(
  host: InstallHost,
  path: string,
  content: string,
  mode: number,
  uid: number,
): Promise<boolean> {
  const facts = await host.stat(path);
  return facts === null || facts.uid !== uid || facts.mode !== mode || (await host.read(path)) !== content;
}

async function needsDir(
  host: InstallHost,
  path: string,
  mode: number,
  uid: number | undefined,
): Promise<boolean> {
  const facts = await host.stat(path);
  return facts === null || facts.mode !== mode || uid === undefined || facts.uid !== uid;
}

/** The bundle and `job-exec` the sudoers rule and the daemon name must be root's alone, or the rule hands them out. */
async function assertRootOwnedPrefix(host: InstallHost, prefix: string): Promise<void> {
  for (const path of [prefix, `${prefix}/bin`, bundleOf(prefix), jobExecOf(prefix)]) {
    const facts = await host.stat(path);
    if (facts === null || facts.uid !== 0 || (facts.mode & 0o022) !== 0) {
      throw new InstallError(
        `${path} must exist, be root-owned and writable by root only: extract the release with sudo (docs/runbooks/runner.md)`,
      );
    }
  }
}

const createUser = (name: string, uid: number, gid: number, home: string, realName: string): InstallStep[] =>
  [
    [],
    ['UniqueID', String(uid)],
    ['PrimaryGroupID', String(gid)],
    ['UserShell', '/usr/bin/false'],
    ['NFSHomeDirectory', home],
    ['RealName', realName],
    ['IsHidden', '1'],
    ['Password', '*'],
  ].map((attribute) => ({
    kind: 'run',
    command: DSCL,
    args: ['.', '-create', `/Users/${name}`, ...attribute],
  }));

async function planUser(options: InstallOptions, host: InstallHost): Promise<InstallPlan> {
  if (host.platform !== 'darwin') {
    throw new InstallError(
      '--backend user installs on macOS (dscl, LaunchDaemon); on Linux use --backend container',
    );
  }
  const home = options.home ?? DOCUMENTED_DEFAULTS.home;
  assertSafePath('--home', home);
  assertSafePath('the release directory', options.prefix);
  assertSafePath('node', options.node);
  await assertRootOwnedPrefix(host, options.prefix);

  const users = await listIds(host, 'Users');
  const groups = await listIds(host, 'Groups');
  const taken = new Set([...users.values(), ...groups.values()]);
  const freeId = (): number => {
    for (let id = ID_RANGE.from; id <= ID_RANGE.to; id += 1) {
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new InstallError(
      `no free id from ${String(ID_RANGE.from)} to ${String(ID_RANGE.to)} for the runner users`,
    );
  };

  const steps: InstallStep[] = [];
  const jobGid = groups.get(JOB_USER) ?? freeId();
  if (!groups.has(JOB_USER)) {
    steps.push({
      kind: 'run',
      command: DSEDITGROUP,
      args: ['-o', 'create', '-i', String(jobGid), '-r', 'team-console job', JOB_USER],
    });
  }
  for (const [name, userHome, realName] of [
    [JOB_USER, '/var/empty', 'team-console job'],
    [RUNNER_USER, home, 'team-console runner'],
  ] as const) {
    if (users.has(name)) {
      // An existing account is kept, but never one with admin rights.
      const admin = await host.exec(DSEDITGROUP, ['-o', 'checkmember', '-m', name, 'admin']);
      if (admin.code === 0) {
        throw new InstallError(`${name} exists and is an admin; remove it from the admin group first`);
      }
    } else {
      steps.push(...createUser(name, freeId(), jobGid, userHome, realName));
    }
  }

  const runnerUid = users.get(RUNNER_USER);
  const runnerOwner = `${RUNNER_USER}:${JOB_USER}`;
  for (const [path, mode] of [
    [home, 0o750],
    [`${home}/credentials`, 0o700],
    [`${home}/logs`, 0o700],
  ] as const) {
    if (await needsDir(host, path, mode, runnerUid)) {
      steps.push({ kind: 'mkdir', path, mode, owner: runnerOwner });
    }
  }

  const settingsPath = SYSTEM_MANAGED_SETTINGS_PATH.darwin;
  const settingsDir = managedSettingsDirOf(settingsPath);
  if (await needsDir(host, settingsDir, 0o755, 0)) {
    steps.push({ kind: 'mkdir', path: settingsDir, mode: 0o755, owner: ROOT_OWNER });
  }
  const sudoers = sudoersRule(options.prefix);
  const files = { node: options.node, prefix: options.prefix, home };
  for (const [path, mode, content] of [
    [settingsPath, 0o644, managedSettingsText()],
    [SUDOERS_PATH, 0o440, sudoers],
    [LAUNCH_DAEMON_PATH, 0o644, launchDaemonPlist(files)],
  ] as const) {
    if (await needsWrite(host, path, content, mode, 0)) {
      if (path === SUDOERS_PATH) {
        // A sudoers file that does not parse can lock every admin out of sudo: checked before it is written.
        steps.push({ kind: 'run', command: '/usr/sbin/visudo', args: ['-c', '-f', '-'], stdin: content });
      }
      steps.push({ kind: 'write', path, mode, owner: ROOT_OWNER, content });
    }
  }

  const runner = `sudo -u ${RUNNER_USER} env HOME=${home} TC_RUNNER_HOME=${home}`;
  return {
    steps,
    next: [
      `1. Enrol: ${runner} ${options.node} ${bundleOf(options.prefix)} enrol --url <console origin> --code <tce_… from Settings › Runners> --backend user --credential setup-token`,
      `2. Claude credential: ${runner} claude setup-token, then store the token it prints: sudo -u ${RUNNER_USER} sh -c 'umask 077; cat > ${home}/credentials/claude-setup-token' (paste, then Ctrl-D)`,
      `3. Start: sudo launchctl bootstrap system ${LAUNCH_DAEMON_PATH}`,
    ],
  };
}

async function planContainer(options: InstallOptions, host: InstallHost): Promise<InstallPlan> {
  if (host.uid === 0) {
    throw new InstallError('install --backend container as the user the runner runs as, without sudo');
  }
  const runtime = options.runtime ?? 'docker';
  if (options.image === undefined || !PINNED_IMAGE.test(options.image)) {
    throw new InstallError('--image must be the runner image pinned by digest: <name>@sha256:<64 hex>');
  }
  const home = options.home ?? join(host.homeDir, '.team-console-runner');
  for (const [label, path] of [
    ['--home', home],
    ['the release directory', options.prefix],
    ['node', options.node],
  ] as const) {
    assertSafePath(label, path);
  }
  if ((await host.exec(runtime, ['version'])).code !== 0) {
    throw new InstallError(`${runtime} is not installed or its daemon is not running`);
  }
  const files = { node: options.node, prefix: options.prefix, home };
  const unit =
    host.platform === 'darwin'
      ? {
          dir: join(host.homeDir, 'Library/LaunchAgents'),
          name: `${LAUNCH_LABEL}.plist`,
          content: launchAgentPlist(files),
        }
      : {
          dir: join(host.homeDir, '.config/systemd/user'),
          name: SYSTEMD_UNIT_NAME,
          content: systemdUnit(files),
        };
  const unitPath = join(unit.dir, unit.name);
  const steps: InstallStep[] = [{ kind: 'run', command: runtime, args: ['pull', options.image] }];
  if (await needsDir(host, home, 0o700, host.uid)) {
    steps.push({ kind: 'mkdir', path: home, mode: 0o700 });
  }
  if ((await host.stat(unit.dir)) === null) {
    steps.push({ kind: 'mkdir', path: unit.dir, mode: 0o755 });
  }
  if (await needsWrite(host, unitPath, unit.content, 0o644, host.uid)) {
    steps.push({ kind: 'write', path: unitPath, mode: 0o644, content: unit.content });
  }
  const start =
    host.platform === 'darwin'
      ? `launchctl bootstrap gui/${String(host.uid)} ${unitPath}`
      : 'systemctl --user daemon-reload && systemctl --user enable --now team-console-runner';
  return {
    steps,
    next: [
      `1. Enrol: TC_RUNNER_HOME=${home} ${options.node} ${bundleOf(options.prefix)} enrol --url <console origin> --code <tce_…> --backend container --image ${options.image} --credential api-key (or --credential claude-config-dir --claude-config-dir <path>)`,
      '2. Credential: put the Anthropic API key in <home>/credentials/anthropic.key (0600), or skip for claude-config-dir',
      `3. Start: ${start}`,
    ],
  };
}

/** Every path a step writes, against decision 11's list; a plan that strays is a bug, refused before anything runs. */
export function assertAllowedPaths(options: InstallOptions, host: InstallHost, plan: InstallPlan): void {
  const home =
    options.home ??
    (options.backend === 'user' ? DOCUMENTED_DEFAULTS.home : join(host.homeDir, '.team-console-runner'));
  const settingsPath = SYSTEM_MANAGED_SETTINGS_PATH.darwin;
  const exact =
    options.backend === 'user'
      ? [LAUNCH_DAEMON_PATH, SUDOERS_PATH, settingsPath, managedSettingsDirOf(settingsPath)]
      : [
          join(host.homeDir, 'Library/LaunchAgents'),
          join(host.homeDir, 'Library/LaunchAgents', `${LAUNCH_LABEL}.plist`),
          join(host.homeDir, '.config/systemd/user'),
          join(host.homeDir, '.config/systemd/user', SYSTEMD_UNIT_NAME),
        ];
  for (const step of plan.steps) {
    if (
      step.kind !== 'run' &&
      !exact.includes(step.path) &&
      step.path !== home &&
      !step.path.startsWith(`${home}/`)
    ) {
      throw new InstallError(`refusing to write ${step.path}: outside what the installer may touch`);
    }
  }
}

const quote = (arg: string): string =>
  /^[A-Za-z0-9._/:=@+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
const octal = (mode: number): string => `0${mode.toString(8)}`;

export function describeStep(step: InstallStep): string {
  switch (step.kind) {
    case 'run':
      return (
        [step.command, ...step.args].map(quote).join(' ') +
        (step.stdin === undefined ? '' : ' < (the file below)')
      );
    case 'mkdir':
      return `mkdir -m ${octal(step.mode)} ${quote(step.path)}${step.owner === undefined ? '' : ` && chown ${step.owner} ${quote(step.path)}`}`;
    case 'write':
      return `write ${quote(step.path)} (${octal(step.mode)}${step.owner === undefined ? '' : ` ${step.owner}`}, ${String(Buffer.byteLength(step.content))} bytes)`;
  }
}

export async function planInstall(options: InstallOptions, host: InstallHost): Promise<InstallPlan> {
  const plan =
    options.backend === 'user' ? await planUser(options, host) : await planContainer(options, host);
  assertAllowedPaths(options, host, plan);
  return plan;
}

/** Plans, then lists (`--dry-run`) or applies (`--yes`) every step in order; stops at the first that fails. */
export async function runInstall(
  options: InstallOptions,
  host: InstallHost,
  out: (line: string) => void,
): Promise<InstallPlan> {
  if (options.apply && options.backend === 'user' && host.uid !== 0) {
    throw new InstallError('install --backend user --yes changes system files: run it with sudo');
  }
  const plan = await planInstall(options, host);
  const who = options.backend === 'user' ? 'as root' : 'as you';
  if (plan.steps.length === 0) {
    out('Already installed: nothing to change.');
  } else {
    out(
      options.apply
        ? `Applying ${String(plan.steps.length)} steps ${who}:`
        : `Dry run, nothing changed. With --yes these ${String(plan.steps.length)} steps run ${who}:`,
    );
  }
  for (const [index, step] of plan.steps.entries()) {
    out(`  ${String(index + 1)}. ${describeStep(step)}`);
    if (options.apply) {
      try {
        await host.apply(step);
      } catch (error: unknown) {
        throw new InstallError(
          `step ${String(index + 1)} failed (${error instanceof Error ? error.message : 'unknown error'}); later steps did not run`,
        );
      }
    }
  }
  out('Then, by hand:');
  plan.next.forEach((line) => out(`  ${line}`));
  return plan;
}

/** The real host. `apply` writes with `O_NOFOLLOW`, sets the mode exactly and chowns by name. */
export function systemInstallHost(base: {
  platform: string;
  uid: number;
  homeDir: string;
  exec: Exec;
}): InstallHost {
  const chown = async (owner: string | undefined, path: string): Promise<void> => {
    if (owner !== undefined && (await base.exec('/usr/sbin/chown', ['-h', owner, path])).code !== 0) {
      throw new Error(`chown ${owner} ${path} failed`);
    }
  };
  return {
    ...base,
    stat: async (path) => {
      try {
        const stats = await lstat(path);
        return { uid: stats.uid, mode: stats.mode & 0o7777 };
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    read: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    apply: async (step) => {
      switch (step.kind) {
        case 'run': {
          const { code } = await base.exec(step.command, step.args, { stdin: step.stdin });
          if (code !== 0) {
            throw new Error(`${step.command} exited ${String(code)}`);
          }
          return;
        }
        case 'mkdir':
          await mkdir(step.path, { recursive: true, mode: step.mode });
          await chmod(step.path, step.mode);
          await chown(step.owner, step.path);
          return;
        case 'write': {
          const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
          const handle = await open(step.path, flags, step.mode);
          try {
            await handle.chmod(step.mode);
            await handle.writeFile(step.content, 'utf8');
          } finally {
            await handle.close();
          }
          await chown(step.owner, step.path);
        }
      }
    },
  };
}
