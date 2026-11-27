import {
  RUNNER_CHECK_DURATION_MAX_MS,
  RUNNER_CHECK_VERSION_PATTERN,
  isClaudeVersion,
  isUlid,
  type FinishRunnerCheckInput,
  type RunnerCheckClaimDto,
  type RunnerCheckKind,
  type RunnerReportedCheckReason,
} from '@shared/contracts';
import { redactSecrets } from '@shared/redaction';
import {
  CommandNotExecutableError,
  type IsolationBackend,
  type RunningProcess,
  type Sandbox,
} from '../backends/backend';
import { EXIT_NOT_EXECUTABLE, EXIT_NOT_FOUND } from '../backends/job-exec';
import type { RunnerConfig, RunnerToolchain } from '../config/config';
import { credentialPresenceOf } from '../env/credential';
import { buildCheckEnv } from '../env/env-builder';
import { LaunchRefusal } from './refusal';

/**
 * One runner check from the claim to its report (#1059; architect note §1 "Runner execution", security note S2–S6,
 * T4, T6, T7, T14). A check is not a job: no job token, project, clone, mirror, plugin, socket or team config. The
 * credential is checked for presence only and never reaches the child; the command, argv, env and time limit come
 * from `CHECK_COMMANDS`, compiled into this release, never from the console's answer. Only a version string or a
 * reason code leaves the host.
 */

export interface CheckConsole {
  finishCheck(checkId: string, input: FinishRunnerCheckInput): Promise<void>;
}

export interface CheckRunDeps {
  readonly home: string;
  readonly config: Pick<RunnerConfig, 'backend' | 'credential' | 'toolchain'>;
  readonly client: CheckConsole;
  readonly backend: IsolationBackend;
  readonly log: (line: string) => void;
  /** Aborted on Ctrl-C / SIGTERM: the check is killed and reported `host-not-ready`. */
  readonly shutdown: AbortSignal;
  /** Milliseconds on a monotonic clock; `performance.now` outside specs. */
  readonly clock?: () => number;
  /** Arms the check's time limit; real timers by default, a spec fires it on an event of its own. */
  readonly armTimeout?: (fire: () => void, ms: number) => () => void;
}

export interface CheckReport {
  readonly result: FinishRunnerCheckInput['result'];
  readonly reason: RunnerReportedCheckReason | null;
  readonly claudeVersion: string | null;
  readonly durationMs: number;
}

interface CheckCommand {
  /** The command of the kind, from the runner's own config; `undefined` when it is not configured. */
  readonly command: (toolchain: RunnerToolchain | undefined) => string | undefined;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

/**
 * What each kind runs (S2): part of the signed release. The console names a kind and nothing else, and its
 * `deadlineSeconds` can only shorten `timeoutMs`.
 */
export const CHECK_COMMANDS: Readonly<Record<RunnerCheckKind, CheckCommand>> = {
  smoke: { command: (toolchain) => toolchain?.claude, argv: ['--version'], timeoutMs: 30_000 },
};

/** The kinds this release declares on every claim: exactly the table's. */
export const DECLARED_CHECKS: readonly RunnerCheckKind[] = (
  Object.keys(CHECK_COMMANDS) as RunnerCheckKind[]
).sort();

/** At most this much of stdout is read; the stream is destroyed after it (S6). */
export const CHECK_STDOUT_MAX_BYTES = 4 * 1024;
const STREAM_DRAIN_MS = 2_000;

const isDeclaredKind = (kind: unknown): kind is RunnerCheckKind =>
  typeof kind === 'string' && Object.hasOwn(CHECK_COMMANDS, kind);

/** `min(local, server)`: the server's deadline can shorten the time limit, never lengthen it. */
export function checkTimeoutMs(kind: RunnerCheckKind, deadlineSeconds: number): number {
  const local = CHECK_COMMANDS[kind].timeoutMs;
  return Number.isInteger(deadlineSeconds) && deadlineSeconds > 0
    ? Math.min(local, deadlineSeconds * 1000)
    : local;
}

/** The shared version shape, unanchored, and not starting inside a longer number. */
const VERSION_IN_TEXT = new RegExp(`(?<![0-9.])${RUNNER_CHECK_VERSION_PATTERN.source.slice(1, -1)}`);

/** The first version in the CLI's output, or `null`: nothing else of the output ever leaves the host. */
export function claudeVersionOf(stdout: string): string | null {
  const version = VERSION_IN_TEXT.exec(stdout)?.[0] ?? null;
  return version !== null && isClaudeVersion(version) && redactSecrets(version, 'loose') === version
    ? version
    : null;
}

const clampDuration = (ms: number): number =>
  Math.min(RUNNER_CHECK_DURATION_MAX_MS, Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0)));

/** Why a credential refusal fails the check: its own three codes; anything else of the launch rules is not-allowed. */
function credentialReasonOf(refusal: LaunchRefusal): RunnerReportedCheckReason {
  switch (refusal.reason) {
    case 'credential-missing':
    case 'credential-unreadable':
      return refusal.reason;
    default:
      return 'credential-not-allowed';
  }
}

interface Watched {
  readonly how: 'exited' | 'timeout' | 'shutdown' | 'stuck';
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** Reads at most `CHECK_STDOUT_MAX_BYTES` of stdout, then destroys the stream so the child cannot fill a pipe. */
function readCapped(stream: RunningProcess['stdout']): { text: () => string; done: Promise<void> } {
  const chunks: Buffer[] = [];
  let size = 0;
  const done = new Promise<void>((resolve) => {
    stream.on('data', (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = CHECK_STDOUT_MAX_BYTES - size;
      if (room > 0) {
        chunks.push(buffer.subarray(0, room));
        size += Math.min(room, buffer.length);
      }
      if (size >= CHECK_STDOUT_MAX_BYTES) {
        stream.destroy();
      }
    });
    stream.once('close', resolve);
    stream.once('end', resolve);
    stream.once('error', () => resolve());
  });
  return { text: () => Buffer.concat(chunks).toString('utf8'), done };
}

async function watch(
  running: RunningProcess,
  timeoutMs: number,
  deps: CheckRunDeps,
  log: (line: string) => void,
): Promise<Watched> {
  const output = readCapped(running.stdout);
  let how: Watched['how'] = 'exited';
  let markStuck: () => void = () => undefined;
  const stuck = new Promise<null>((resolve) => {
    markStuck = () => resolve(null);
  });
  const stop = (reason: 'timeout' | 'shutdown'): void => {
    if (how !== 'exited') {
      return;
    }
    how = reason;
    deps.backend.kill(running).catch((error: unknown) => {
      log(`could not stop the check: ${error instanceof Error ? error.message : 'unknown error'}`);
      how = 'stuck';
      markStuck();
    });
  };
  const arm =
    deps.armTimeout ??
    ((fire: () => void, ms: number) => {
      const id = setTimeout(fire, ms);
      return () => clearTimeout(id);
    });
  const disarm = arm(() => stop('timeout'), timeoutMs);
  const onShutdown = (): void => stop('shutdown');
  deps.shutdown.addEventListener('abort', onShutdown);
  if (deps.shutdown.aborted) {
    onShutdown();
  }
  try {
    const status = await Promise.race([running.exited, stuck]);
    // A detached child can hold the pipe open; the cleanup's sweep ends it, so the wait is bounded.
    await Promise.race([
      output.done,
      new Promise<void>((resolve) => setTimeout(resolve, STREAM_DRAIN_MS).unref()),
    ]);
    running.stdout.destroy();
    return { how, exitCode: status?.exitCode ?? null, stdout: output.text() };
  } finally {
    disarm();
    deps.shutdown.removeEventListener('abort', onShutdown);
  }
}

type Outcome = Omit<CheckReport, 'durationMs'>;

const failedWith = (reason: RunnerReportedCheckReason): Outcome => ({
  result: 'failed',
  reason,
  claudeVersion: null,
});

function outcomeOf(watched: Watched, log: (line: string) => void): Outcome {
  switch (watched.how) {
    case 'timeout':
      return failedWith('timeout');
    case 'shutdown':
    case 'stuck':
      return failedWith('host-not-ready');
    case 'exited':
      break;
  }
  const { exitCode } = watched;
  if (exitCode === EXIT_NOT_FOUND || exitCode === EXIT_NOT_EXECUTABLE) {
    log(`claude could not be executed (exit ${String(exitCode)})`);
    return failedWith('claude-not-executable');
  }
  if (exitCode !== 0) {
    // The exit code stays in the local log; the console learns the reason code only.
    log(`claude --version exited ${String(exitCode)}`);
    return failedWith('claude-failed');
  }
  const claudeVersion = claudeVersionOf(watched.stdout);
  return claudeVersion === null
    ? failedWith('claude-output-unrecognised')
    : { result: 'passed', reason: null, claudeVersion };
}

/** Where the sandbox is kept between `attempt` and the cleanup that always follows it. */
interface Held {
  sandbox: Sandbox | null;
}

/** Steps 1–7 of the architect note: credential presence, toolchain, preflight and prepare, launch, watch. */
async function attempt(
  check: RunnerCheckClaimDto & { readonly kind: RunnerCheckKind },
  deps: CheckRunDeps,
  log: (line: string) => void,
  held: Held,
): Promise<Outcome> {
  const { backend, config } = deps;
  const entry = CHECK_COMMANDS[check.kind];
  try {
    await credentialPresenceOf(deps.home, config.credential, backend.kind);
  } catch (error: unknown) {
    if (error instanceof LaunchRefusal) {
      log(`credential refused: ${error.message}`);
      return failedWith(credentialReasonOf(error));
    }
    throw error;
  }
  const command = entry.command(config.toolchain);
  if (command === undefined || config.toolchain === undefined) {
    log('config.json has no toolchain.claude (run setup --only toolchain)');
    return failedWith('claude-not-configured');
  }
  if (backend.launchCheck === undefined) {
    log(`the ${backend.kind} backend runs no checks`);
    return failedWith('host-not-ready');
  }
  let sandbox: Sandbox;
  try {
    await backend.preflight();
    sandbox = await backend.prepare({ jobId: check.id, projectSlug: null });
  } catch (error: unknown) {
    log(`the host is not ready: ${error instanceof Error ? error.message : 'unknown error'}`);
    return failedWith('host-not-ready');
  }
  held.sandbox = sandbox;
  const env = buildCheckEnv({ path: config.toolchain.path, home: sandbox.home, tmp: sandbox.tmp });
  let running: RunningProcess;
  try {
    running = await backend.launchCheck(sandbox, {
      command,
      argv: entry.argv,
      env: { ...env },
      cwd: sandbox.home,
    });
  } catch (error: unknown) {
    log(`could not start claude: ${error instanceof Error ? error.message : 'unknown error'}`);
    return failedWith(
      error instanceof CommandNotExecutableError ? 'claude-not-executable' : 'host-not-ready',
    );
  }
  return outcomeOf(await watch(running, checkTimeoutMs(check.kind, check.deadlineSeconds), deps, log), log);
}

function finishOf(report: CheckReport): FinishRunnerCheckInput {
  return report.result === 'passed' && report.claudeVersion !== null
    ? { result: 'passed', claudeVersion: report.claudeVersion, durationMs: report.durationMs }
    : { result: 'failed', reason: report.reason ?? 'host-not-ready', durationMs: report.durationMs };
}

/**
 * Runs the check and reports it. It never throws, so the loop goes on to its next claim whatever happened; `null`
 * when the check itself is malformed and nothing was run or reported.
 */
export async function runCheck(check: RunnerCheckClaimDto, deps: CheckRunDeps): Promise<CheckReport | null> {
  const clock = deps.clock ?? (() => performance.now());
  const say = (line: string): void => deps.log(redactSecrets(line, 'loose'));
  const { kind } = check;
  // The client judged the answer already; judged again here, since the id becomes a path and the kind a command.
  if (!isUlid(check.id) || !isDeclaredKind(kind)) {
    say('check: unexpected answer from the console; nothing was run');
    return null;
  }
  const log = (line: string): void => say(`check ${check.id} ${kind}: ${line}`);
  const started = clock();
  const held: Held = { sandbox: null };
  let outcome: Outcome;
  try {
    outcome = await attempt({ ...check, kind }, deps, log, held);
  } catch (error: unknown) {
    log(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    outcome = failedWith('host-not-ready');
  } finally {
    if (held.sandbox !== null) {
      try {
        await deps.backend.cleanup(held.sandbox);
      } catch (error: unknown) {
        log(`cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        // A pass on a host that cannot clean up after itself is not a pass.
        outcome = failedWith('host-not-ready');
      }
    }
  }
  const report: CheckReport = { ...outcome, durationMs: clampDuration(clock() - started) };
  log(
    report.result === 'passed'
      ? `passed (claude ${String(report.claudeVersion)}, ${String(report.durationMs)} ms)`
      : `failed (${String(report.reason)}, ${String(report.durationMs)} ms)`,
  );
  try {
    await deps.client.finishCheck(check.id, finishOf(report));
  } catch (error: unknown) {
    // Once: the console answers one 404 for a check it no longer holds, and the next claim goes on.
    log(`the console did not take the report: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return report;
}
