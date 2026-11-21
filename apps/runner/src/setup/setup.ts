import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNNER_USER } from '../backends/user';
import { apiOriginOf } from '../config/config';
import { InstallError, runInstall } from '../install/install';
import { DOCUMENTED_DEFAULTS, LAUNCH_DAEMON_PATH, LAUNCH_LABEL } from '../install/templates';
import { installTarball, liveReleaseOf } from '../update/update';
import { RUNNER_VERSION } from '../version';
import { CREDENTIAL_FILE_OF, type SetUpCredentialKind } from './credential';
import { runnerHalfOf, selfCheck, type SetupHost } from './self-check';
import { isSignInUrl } from './sign-in-url';
import { ToolchainError, detectToolchain } from './toolchain';

/**
 * `sudo team-console-runner setup --url <console> --enrolment <request id>` (#634 PR 2, architect note sections 0–5):
 * one verb for the host side of the `user` backend on macOS. As root it only verifies and copies the release, applies
 * the installer's plan (`install.ts`, `assertAllowedPaths` still the gate), probes the toolchain as `_tcjob` and
 * starts the service. Everything that touches the runner's key, config or Claude credential runs as `_tcrunner`
 * through `runAsRunner` (stdio inherited: root never reads that output). Each step is idempotent, so `--only` re-runs
 * one after a fix; the run ends with `self-check`.
 */

export const SETUP_STEPS = ['install', 'enrol', 'toolchain', 'credential', 'service', 'check'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const isSetupStep = (value: string): value is SetupStep => (SETUP_STEPS as readonly string[]).includes(value);

/** What the `.pkg` postinstall runs: the files are in place, there is no terminal to enrol or sign in from. */
const FROM_PKG_STEPS: readonly SetupStep[] = ['install', 'service'];

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export interface SetupOptions {
  readonly url?: string | undefined;
  readonly enrolment?: string | undefined;
  readonly only?: readonly SetupStep[] | undefined;
  readonly fromPkg: boolean;
  /** The downloaded tarball and the sum the console named for it (R-ONE-1); without them the running prefix is used. */
  readonly release?: { readonly tarball: string; readonly sha256: string } | undefined;
  readonly credential: SetUpCredentialKind;
  readonly replaceCredential: boolean;
  /** Where the running bundle is. */
  readonly prefix: string;
  /** The node running this process, as started (the launcher allows root only a root-owned one). */
  readonly node: string;
}

/** The side channel the credential step's child asks root to open the sign-in page through (R-TOK-2). */
export interface OpenRequestChannel {
  readonly path: string;
  /** What the child appended since the last call. */
  take(): Promise<string>;
  close(): Promise<void>;
}

export interface SetupDeps {
  readonly host: SetupHost;
  readonly out: (line: string) => void;
  /** Root's temporary directory for staging the release (a fresh 0700 directory per run). */
  readonly tmpRoot: string;
  readonly openRequestChannel: () => Promise<OpenRequestChannel>;
  /** Opens a checked sign-in URL in the browser of the user who ran `sudo` (never root, never `_tcrunner`). */
  readonly openForUser: (url: string) => Promise<void>;
  /** How often the channel is read while the CLI runs, and how long `self-check` watches the service. */
  readonly pollMs?: number;
  readonly settleMs?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const TARBALL_MAX_BYTES = 512 * 1024 * 1024;
const LAUNCHCTL = '/bin/launchctl';

function stepsOf(options: SetupOptions): readonly SetupStep[] {
  if (options.fromPkg) {
    if (options.enrolment !== undefined || options.release !== undefined || options.only !== undefined) {
      throw new SetupError('--from-pkg takes no --enrolment, --release or --only: the package put the files in place');
    }
    return FROM_PKG_STEPS;
  }
  const only = options.only ?? SETUP_STEPS;
  return SETUP_STEPS.filter((step) => only.includes(step));
}

/**
 * R-ONE-1: the tarball the operator downloaded is copied into a root-owned 0700 directory, hashed there against the
 * sum the console named, and unpacked from that copy, so nothing the login user can still change is installed.
 */
async function installRelease(release: NonNullable<SetupOptions['release']>, deps: SetupDeps, node: string, prefix: string): Promise<void> {
  if (!SHA256.test(release.sha256)) {
    throw new SetupError('--sha256 must be the 64 hex characters the console showed for this release');
  }
  if ((await liveReleaseOf(prefix)) === RUNNER_VERSION) {
    deps.out(`install: release ${RUNNER_VERSION} is already in ${prefix}`);
    return;
  }
  const staging = await mkdtemp(join(deps.tmpRoot, 'tcr-setup-'));
  try {
    const staged = join(staging, 'release.tar.gz');
    const source = await open(release.tarball, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await source.stat();
      if (!stats.isFile() || stats.size > TARBALL_MAX_BYTES) {
        throw new SetupError(`${release.tarball} is not a release tarball`);
      }
      const target = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await target.writeFile(await source.readFile());
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
    const copy = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    let digest: string;
    try {
      digest = createHash('sha256').update(await copy.readFile()).digest('hex');
    } finally {
      await copy.close();
    }
    if (digest !== release.sha256) {
      throw new SetupError('the release tarball does not match the sum the console named; nothing was installed');
    }
    await mkdir(prefix, { recursive: true, mode: 0o755 });
    await installTarball(staged, staging, prefix, RUNNER_VERSION, { exec: deps.host.exec, node });
    deps.out(`install: release ${RUNNER_VERSION} verified and copied to ${prefix}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function enrolStep(options: SetupOptions, deps: SetupDeps, home: string): Promise<void> {
  if ((await deps.host.stat(`${home}/config.json`)) !== null) {
    const report = await runnerHalfOf(deps.host);
    const url = options.url === undefined ? null : apiOriginOf(options.url);
    if (url !== null && report?.config !== null && report?.config.apiUrl !== url) {
      throw new SetupError(
        `this runner is enrolled with ${report?.config?.apiUrl ?? 'another console'}, not ${url}: revoke it and remove ${home} (runbook) to enrol it again`,
      );
    }
    deps.out(`enrol: already enrolled as «${report?.config?.name ?? '?'}»${options.enrolment === undefined ? '' : '; --enrolment is not used'}`);
    return;
  }
  if (options.url === undefined || options.enrolment === undefined) {
    throw new SetupError('enrol: a new runner needs --url <console origin> and --enrolment <request id> from Settings › Runners › Add runner');
  }
  const code = await deps.host.runAsRunner([
    'enrol',
    '--url',
    options.url,
    '--backend',
    'user',
    '--credential',
    options.credential,
    '--enrolment',
    options.enrolment,
  ]);
  if (code !== 0) {
    throw new SetupError('enrol did not finish (its reason is above); run setup again with a new request from the console');
  }
}

async function toolchainStep(deps: SetupDeps, prefix: string): Promise<void> {
  let detected;
  try {
    detected = await detectToolchain(deps.host, '', prefix);
  } catch (error: unknown) {
    if (error instanceof ToolchainError) {
      throw new SetupError(error.message);
    }
    throw error;
  }
  detected.warnings.forEach((warning) => deps.out(`toolchain: warning: ${warning}`));
  const { path, claude } = detected.toolchain;
  if ((await deps.host.runAsRunner(['setup-toolchain', '--path', path, '--claude', claude])) !== 0) {
    throw new SetupError('toolchain: config.json could not be updated (the reason is above)');
  }
  deps.out(`toolchain: claude ${claude}; job PATH ${path}`);
}

async function credentialStep(options: SetupOptions, deps: SetupDeps, home: string): Promise<void> {
  const file = CREDENTIAL_FILE_OF[options.credential];
  if (!options.replaceCredential && (await deps.host.stat(`${home}/${file}`)) !== null) {
    deps.out(`credential: ${file} is present and kept (--replace-credential to replace it)`);
    return;
  }
  const channel = await deps.openRequestChannel();
  const opened = new Set<string>();
  const drain = async (): Promise<void> => {
    for (const line of (await channel.take()).split('\n')) {
      // Judged again here: the child is another user, so its request is data, never trusted.
      if (line !== '' && !opened.has(line) && isSignInUrl(line)) {
        opened.add(line);
        await deps.openForUser(line);
      }
    }
  };
  let running = true;
  const watcher = (async (): Promise<void> => {
    while (running) {
      await drain();
      await deps.host.sleep(deps.pollMs ?? 300);
    }
  })();
  try {
    const code = await deps.host.runAsRunner([
      'setup-credential',
      '--kind',
      options.credential,
      ...(options.replaceCredential ? ['--replace'] : []),
      '--open-requests',
      channel.path,
    ]);
    if (code !== 0) {
      throw new SetupError('credential: nothing was written; run sudo team-console-runner setup --only credential again');
    }
  } finally {
    running = false;
    await watcher;
    await channel.close();
  }
}

async function serviceStep(deps: SetupDeps): Promise<void> {
  const loaded = (await deps.host.exec(LAUNCHCTL, ['print', `system/${LAUNCH_LABEL}`])).code === 0;
  const args = loaded ? ['kickstart', '-k', `system/${LAUNCH_LABEL}`] : ['bootstrap', 'system', LAUNCH_DAEMON_PATH];
  if ((await deps.host.exec(LAUNCHCTL, args)).code !== 0) {
    throw new SetupError(`service: launchctl ${args.join(' ')} failed`);
  }
  deps.out(`service: ${loaded ? 'restarted' : 'started'} ${LAUNCH_LABEL}`);
}

/** Where the release lives once `install` ran: the documented prefix for a downloaded release, else where it runs. */
export const installedPrefixOf = (options: Pick<SetupOptions, 'release' | 'prefix'>): string =>
  options.release === undefined ? options.prefix : DOCUMENTED_DEFAULTS.prefix;

/** Runs the chosen steps in order; stops at the first that fails with the one line to act on. */
export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<boolean> {
  const { host } = deps;
  if (host.platform !== 'darwin') {
    throw new SetupError('setup sets up the user backend on macOS; on Linux use the container backend (docs/runbooks/runner.md)');
  }
  if (host.uid !== 0) {
    throw new SetupError(`setup creates ${RUNNER_USER} and a LaunchDaemon: run it with sudo`);
  }
  if (options.url !== undefined && apiOriginOf(options.url) === null) {
    throw new SetupError('--url must be the console origin, https://… (http only for a loopback host)');
  }
  const steps = stepsOf(options);
  const home = DOCUMENTED_DEFAULTS.home;
  const prefix = installedPrefixOf(options);
  for (const step of steps) {
    switch (step) {
      case 'install':
        if (options.release !== undefined) {
          await installRelease(options.release, deps, options.node, prefix);
        }
        try {
          await runInstall({ backend: 'user', apply: true, prefix, node: options.node }, host, deps.out, { showNext: false });
        } catch (error: unknown) {
          throw error instanceof InstallError ? new SetupError(`install: ${error.message}`) : error;
        }
        break;
      case 'enrol':
        await enrolStep(options, deps, home);
        break;
      case 'toolchain':
        await toolchainStep(deps, prefix);
        break;
      case 'credential':
        await credentialStep(options, deps, home);
        break;
      case 'service':
        await serviceStep(deps);
        break;
      case 'check':
        return await selfCheck(host, { home, prefix, out: deps.out, settleMs: deps.settleMs ?? 20_000 });
    }
  }
  return true;
}
