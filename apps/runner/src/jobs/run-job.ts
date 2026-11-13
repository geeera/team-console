import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  JOB_SUMMARY_MAX_LENGTH,
  isValidSlug,
  type FinishJobInput,
  type JobDto,
  type JobEventInput,
  type JobEventsResponse,
  type HeartbeatResponse,
} from '@shared/contracts';
import { redactSecrets } from '@shared/redaction';
import type { IsolationBackend, RunningJob, Sandbox } from '../backends/backend';
import { detectOutcome, type LimitReason } from '../budget/detect';
import { writeManagedSettings } from '../claude/managed-settings';
import { promptOf } from '../claude/prompts';
import { modelOfRole } from '../claude/roles';
import { EVENT_TEXT_MAX, parseStreamLine, type StreamResult } from '../claude/stream-json';
import { RunnerApiError } from '../client/runner-client';
import type { RunnerConfig } from '../config/config';
import { jobCredentialOf } from '../env/credential';
import { DEFAULT_TOOLCHAIN_PATH, buildJobEnv } from '../env/env-builder';
import { runnerGitEnv } from '../git/git';
import { cloneForJob, syncMirror, vendorPlugin } from '../git/workspace';
import type { JobRegistry } from '../proxy/job-registry';
import { startJobSocket, type JobSocket, type ProxyForwarder } from '../proxy/socket-server';
import { EventQueue } from './event-queue';
import { LaunchRefusal } from './refusal';

/**
 * One claimed job from `started` to `finish` (ADR 0006 "Run", ADR 0008 decisions 3–9; architect note on #468, PR 2):
 * the sandbox, mirror, clone, plugin and settings are prepared, the launch is refused on any env, credential or git
 * finding, the CLI runs with exactly the built env while a heartbeat holds the lease, and its stream becomes events.
 * It is killed at `maxMinutes`, on a lost lease and on shutdown. The job token is dropped from the socket only after
 * `finish`, and the sandbox is wiped whatever happened.
 */

export interface JobConsole extends ProxyForwarder {
  events(jobId: string, events: readonly JobEventInput[]): Promise<JobEventsResponse>;
  heartbeat(jobId: string): Promise<HeartbeatResponse>;
  finish(jobId: string, input: FinishJobInput): Promise<void>;
}

export interface JobRunDeps {
  readonly home: string;
  readonly config: RunnerConfig;
  readonly client: JobConsole;
  readonly backend: IsolationBackend;
  readonly registry: JobRegistry;
  /** The runner's own environment: passthrough values and the runner's git only, never the job's env. */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly now: () => Date;
  /** Aborted on Ctrl-C / SIGTERM. */
  readonly shutdown: AbortSignal;
  readonly limitStreak: number;
  readonly heartbeatMs?: number;
  readonly flushMs?: number;
  /** One minute of `maxMinutes`; shorter in specs. */
  readonly minuteMs?: number;
}

export type StopReason = 'max-minutes' | 'runner-shutdown' | 'lease-lost';

export interface JobReport {
  readonly result: FinishJobInput['result'];
  readonly reason: string | null;
  readonly limit: { readonly reason: LimitReason; readonly retryAt: string } | null;
}

const HEARTBEAT_MS = 60_000;
const FLUSH_MS = 2_000;
const STREAM_DRAIN_MS = 2_000;
const TEXT_TAIL = 50;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `costUsd`, `turns` and `durationMs` from the CLI's `result` event, where it gave them. */
function metricsOf(result: StreamResult | null): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [name, value] of Object.entries({
    costUsd: result?.costUsd ?? null,
    turns: result?.turns ?? null,
    durationMs: result?.durationMs ?? null,
  })) {
    if (value !== null) {
      metrics[name] = value;
    }
  }
  return metrics;
}

function failed(summary: string, metrics: Record<string, unknown>): FinishJobInput {
  return { result: 'failed', summary: clip(summary, JOB_SUMMARY_MAX_LENGTH), metrics, acted: false };
}

const isLeaseGone = (error: unknown): boolean =>
  error instanceof RunnerApiError && (error.status === 409 || error.status === 404 || error.status === 410);

export async function runJob(job: JobDto, jobToken: string, deps: JobRunDeps): Promise<JobReport> {
  const { backend, client, config, registry } = deps;
  const log = (line: string): void => deps.log(redactSecrets(`job ${job.id}: ${line}`, 'loose'));
  const reportError = (error: unknown): void => {
    log(error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error');
  };
  registry.register({ id: job.id, projectSlug: job.projectSlug }, jobToken);
  const events = new EventQueue(client, job.id, reportError, deps.flushMs ?? FLUSH_MS);

  let stopReason: StopReason | null = null;
  let running: RunningJob | null = null;
  const stop = (reason: StopReason): void => {
    if (stopReason !== null) {
      return;
    }
    stopReason = reason;
    log(`stopping: ${reason}`);
    if (running !== null) {
      backend.kill(running).catch(reportError);
    }
  };
  const onShutdown = (): void => stop('runner-shutdown');
  deps.shutdown.addEventListener('abort', onShutdown);
  const heartbeat = setInterval(() => {
    client.heartbeat(job.id).catch((error: unknown) => {
      reportError(error);
      if (isLeaseGone(error)) {
        stop('lease-lost');
      }
    });
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  const deadline = setTimeout(() => stop('max-minutes'), job.maxMinutes * (deps.minuteMs ?? 60_000));

  let sandbox: Sandbox | null = null;
  let socket: JobSocket | null = null;
  let finish: FinishJobInput;
  let limit: JobReport['limit'] = null;
  try {
    await client.events(job.id, [
      {
        level: 'info',
        kind: 'started',
        payload: { kind: job.kind, attempt: job.attempt, backend: backend.kind },
      },
    ]);
    if (deps.shutdown.aborted) {
      stop('runner-shutdown');
    }

    // Everything a launch may be refused on is judged before the CLI starts.
    if (!isValidSlug(job.projectSlug)) {
      throw new LaunchRefusal('repository-not-configured', 'the job names no valid project slug');
    }
    const model = modelOfRole(job.role, config.roles);
    const upstream = config.repositories?.[job.projectSlug];
    if (upstream === undefined) {
      throw new LaunchRefusal(
        'repository-not-configured',
        `config.json has no repositories.${job.projectSlug}`,
      );
    }
    const credential = await jobCredentialOf(deps.home, config.credential, config.backend);
    sandbox = await backend.prepare({ jobId: job.id, projectSlug: job.projectSlug });
    const socketPath = join(sandbox.socketDir, 'tc.sock');
    const { env, passedThrough } = buildJobEnv({
      jobToken,
      projectSlug: job.projectSlug,
      consoleUrl: config.apiUrl,
      socketPath,
      home: sandbox.home,
      tmp: sandbox.tmp,
      toolchainPath: config.toolchain?.path ?? DEFAULT_TOOLCHAIN_PATH,
      dispatch: job.dispatch,
      credential,
      passthrough: config.env?.passthrough ?? [],
      source: deps.sourceEnv,
    });
    const runnerGit = runnerGitEnv(deps.sourceEnv);
    const gitEnvs = {
      runner: runnerGit,
      job: {
        PATH: runnerGit['PATH'] ?? '/usr/bin:/bin',
        HOME: sandbox.home,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    };
    const mirror = await syncMirror(deps.home, job.projectSlug, upstream, gitEnvs);
    await cloneForJob(mirror, sandbox.clone, upstream, gitEnvs);
    const pluginRoot = await vendorPlugin(deps.home, mirror, gitEnvs.job);
    const settingsPath = await writeManagedSettings(deps.home);
    if (passedThrough.length > 0) {
      events.push({ level: 'warn', kind: 'notice', payload: { passthrough: passedThrough } });
    }
    socket = await startJobSocket({
      socketPath,
      job: { id: job.id, projectSlug: job.projectSlug },
      registry,
      forwarder: client,
      notice: async (_jobId, notice) => {
        events.push({ level: 'warn', kind: 'notice', payload: { ...notice } });
      },
      onError: reportError,
    });

    if (stopReason !== null) {
      finish = failed(`Stopped before the launch: ${String(stopReason)}`, { reason: stopReason });
    } else {
      const launched = await backend.launch(sandbox, {
        command: config.toolchain?.claude ?? 'claude',
        argv: [
          '-p',
          promptOf({ job, pluginRoot }),
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          model,
          '--settings',
          settingsPath,
        ],
        env,
        cwd: sandbox.clone,
        maxMinutes: job.maxMinutes,
        readOnly: { plugin: pluginRoot, managedSettings: settingsPath },
      });
      running = launched;
      ({ finish, limit } = await watch(launched, events, deps, () => stopReason));
    }
  } catch (error: unknown) {
    if (error instanceof LaunchRefusal) {
      log(`launch refused: ${error.reason}`);
      events.push({
        level: 'error',
        kind: 'notice',
        payload: { refused: error.reason, detail: clip(error.message, 500) },
      });
      finish = failed(`Launch refused: ${error.message}`, { reason: error.reason });
    } else {
      reportError(error);
      finish = failed('The runner failed while preparing or running the job.', {
        reason: stopReason ?? 'runner-error',
      });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    deps.shutdown.removeEventListener('abort', onShutdown);
  }

  try {
    await events.close();
    await client.finish(job.id, finish);
  } catch (error: unknown) {
    reportError(error);
  } finally {
    // Only now: a job's call on the socket keeps working until the console has its finish.
    registry.drop(job.id);
    await socket?.close().catch(reportError);
    if (sandbox !== null) {
      await backend.cleanup(sandbox).catch(reportError);
    }
  }
  const reason = typeof finish.metrics['reason'] === 'string' ? finish.metrics['reason'] : null;
  log(`${finish.result}${reason === null ? '' : ` (${reason})`}`);
  return { result: finish.result, reason, limit };
}

/** Streams the CLI into events until it exits, then says how the job ended. */
async function watch(
  running: RunningJob,
  events: EventQueue,
  deps: JobRunDeps,
  stopReason: () => StopReason | null,
): Promise<{ finish: FinishJobInput; limit: JobReport['limit'] }> {
  const seen: { result: StreamResult | null } = { result: null };
  const texts: string[] = [];
  const keep = (text: string): void => {
    if (text !== '') {
      texts.push(clip(text, EVENT_TEXT_MAX));
      texts.splice(0, Math.max(0, texts.length - TEXT_TAIL));
    }
  };
  const stdout = createInterface({ input: running.stdout, crlfDelay: Infinity });
  const stderr = createInterface({ input: running.stderr, crlfDelay: Infinity });
  stdout.on('line', (line) => {
    const parsed = parseStreamLine(line);
    events.push(...parsed.events);
    keep(parsed.text);
    seen.result = parsed.result ?? seen.result;
  });
  stderr.on('line', (line) => {
    if (line.trim() !== '') {
      events.push({ level: 'warn', kind: 'log', payload: { stderr: clip(line, EVENT_TEXT_MAX) } });
      keep(line);
    }
  });
  const drained = Promise.all([
    new Promise<void>((resolve) => stdout.once('close', resolve)),
    new Promise<void>((resolve) => stderr.once('close', resolve)),
  ]);
  const status = await running.exited;
  // A detached child can hold the pipes open; the sandbox sweep ends it, so the wait is bounded.
  await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, STREAM_DRAIN_MS).unref())]);
  stdout.close();
  stderr.close();

  const exit = { exitCode: status.exitCode, signal: status.signal };
  const stopped = stopReason();
  const final = seen.result;
  if (stopped !== null) {
    return {
      finish: failed(`Stopped: ${stopped}`, { reason: stopped, ...exit, ...metricsOf(final) }),
      limit: null,
    };
  }
  const outcome = detectOutcome({
    exitCode: status.exitCode,
    result: final,
    texts,
    limitStreak: deps.limitStreak,
    now: deps.now(),
  });
  switch (outcome.kind) {
    case 'success':
      return {
        finish: {
          result: 'finished',
          summary: clip(final?.text ?? '', JOB_SUMMARY_MAX_LENGTH),
          metrics: { exitCode: 0, ...metricsOf(final) },
          acted: false,
        },
        limit: null,
      };
    case 'limit': {
      const retryAt = outcome.retryAt.toISOString();
      events.push({ level: 'warn', kind: 'paused', payload: { reason: outcome.reason, retryAt } });
      return {
        finish: failed(`Claude ${outcome.reason}: the runner pauses until ${retryAt}.`, {
          reason: outcome.reason,
          retryAt,
          pattern: outcome.pattern,
          ...exit,
          ...metricsOf(final),
        }),
        limit: { reason: outcome.reason, retryAt },
      };
    }
    case 'failed':
      return {
        finish: failed(
          final?.text !== undefined && final.text !== ''
            ? final.text
            : `The CLI exited with ${String(status.exitCode)}.`,
          {
            reason: 'exit',
            ...exit,
            ...metricsOf(final),
          },
        ),
        limit: null,
      };
  }
}
