import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  PAUSE_REASON_MAX_LENGTH,
  TEAM_SLOTS,
  isTeamSlot,
  slotSecretNames,
  type RunResponse,
  type SlotLock,
  type SlotStatusDto,
  type TeamCommandResponse,
  type TeamSlot,
  type TeamState,
  type TeamStatusDto,
} from '@shared/contracts';
import { problem, type ProblemInit, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { OwnWritesRepo, SlotRequestsRepo, type OwnWrite, type OwnWriteKind } from '@worker/db';
import { GitHubError, githubPath, type FetchLike, type RepoName } from '@worker/github';
import { InvalidRoutineConfigError, RoutinesClient, type FireOutcome } from '@worker/routines';
import {
  OVERLAP_WINDOW_MS,
  PAUSED_LABEL,
  RUN_LOG_SLOTS,
  decide,
  effectiveState,
  pauseCommentBody,
  resumeCommentBody,
  timeOf,
  type Run,
} from '@worker/run-log';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { jsonBody } from '../json-body';
import { isNotWritten, ownerWriter, sha256Hex } from '../owner/owner-writer';
import { connectedOwnerSource, type OwnerConnectionSource } from '../projects/owner-connection';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { RunLogUnavailableError, readRunLog, type RunLogView } from '../team/run-log-reader';
import { routinesFetch } from '../team/routines';
import { missingSlotsOf, slotTriggerOf } from '../team/slot-secrets';

type Context = WorkerContext<ApiEnv>;

/** A repeat of the same pause or resume within this window is answered from `own_writes`, not written again. */
export const COMMAND_REPLAY_WINDOW_MS = 60_000;
/** The clone-and-setup gap before `runlog start` writes its entry (architect note on #114 §4). */
export const REQUEST_LOCK_MS = 15 * 60 * 1000;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024;
// Markers would end the HTML comment the record sits in; control characters have no place in one line of words.
const COMMENT_MARKERS = /<!--|-->/;

function hasControlCharacter(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

interface GitHubComment {
  readonly id: number;
  readonly html_url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isComment(value: unknown): value is GitHubComment {
  return isRecord(value) && Number.isSafeInteger(value['id']) && typeof value['html_url'] === 'string';
}

const isAnything = (value: unknown): value is unknown => value !== undefined;

function invalid(c: Context, detail: string): Response {
  return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parsePause(body: unknown): { reason: string } | string {
  if (body === undefined) {
    return { reason: '' };
  }
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'reason')) {
    return 'The body may only carry reason';
  }
  const reason = body['reason'] ?? '';
  if (typeof reason !== 'string' || reason.length > PAUSE_REASON_MAX_LENGTH) {
    return `reason must be a string of at most ${PAUSE_REASON_MAX_LENGTH} characters`;
  }
  if (COMMENT_MARKERS.test(reason) || hasControlCharacter(reason)) {
    return 'reason must be one line without HTML comment markers';
  }
  return { reason: reason.trim() };
}

function parseRun(body: unknown): { slot: TeamSlot } | string {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'slot') || !isTeamSlot(body['slot'])) {
    return 'The body must be {"slot": "pm" | "dev" | "qa"}';
  }
  return { slot: body['slot'] };
}

/** The run of the slot the run log shows in progress (`decide` → overlap), with its window. */
function startedLock(view: RunLogView, slot: TeamSlot, nowMs: number): SlotLock | null {
  const verdict = decide(view.runs, RUN_LOG_SLOTS[slot], nowMs, false);
  if (verdict.decision !== 'overlap' || verdict.runId === undefined) {
    return null;
  }
  const run = view.runs.find((candidate) => candidate.id === verdict.runId);
  const since = run?.at ?? iso(nowMs);
  return { kind: 'started', runId: verdict.runId, since, until: iso(timeOf(since) + OVERLAP_WINDOW_MS) };
}

/**
 * Requests newer than this lock the slot: younger than 15 minutes and not yet followed by a run of the slot in the
 * log. Once the log shows the run, the 3-hour rule takes over.
 */
function requestCutoff(view: RunLogView, slot: TeamSlot, nowMs: number): string {
  const name = RUN_LOG_SLOTS[slot];
  const latestStart = view.runs
    .filter((run) => run.slot === name && run.at !== null)
    .reduce((latest, run) => Math.max(latest, timeOf(run.at)), Number.NEGATIVE_INFINITY);
  return iso(Math.max(nowMs - REQUEST_LOCK_MS, Number.isFinite(latestStart) ? latestStart : 0));
}

function lastRunOf(runs: readonly Run[], slot: TeamSlot, nowMs: number): SlotStatusDto['lastRun'] {
  const name = RUN_LOG_SLOTS[slot];
  for (const run of [...runs].reverse()) {
    const state = effectiveState(run, nowMs);
    if (run.slot === name && state !== 'started') {
      // A state the plugin does not know yet reads as unknown rather than as a success.
      const shown = state === 'finished' ? 'finished' : state === 'failed' ? 'failed' : 'unknown';
      return { at: run.finishedAt ?? run.at ?? '', state: shown };
    }
  }
  return null;
}

function runLogMissing(c: Context, reason: 'none' | 'untrusted' | 'ambiguous'): Response {
  return problem(c, {
    type: 'run-log-missing',
    title: 'The team has no usable run log',
    status: 409,
    detail:
      reason === 'none'
        ? 'The team has not opened its run log yet'
        : reason === 'untrusted'
          ? 'The pinned run log was not opened by the team or the owner'
          : 'Several run logs: pin one as team.run_log_issue in .product-team/project.yml',
    extensions: { reason },
  });
}

/** The run log, or the 409 that says why there is none. */
async function runLogOrProblem(
  c: Context,
  installation: GitHubConnection,
  repo: RepoName,
): Promise<RunLogView | Response> {
  try {
    return await readRunLog(installation, repo);
  } catch (error: unknown) {
    if (error instanceof RunLogUnavailableError) {
      return runLogMissing(c, error.reason);
    }
    throw error;
  }
}

function notConfigured(c: Context, extensions: ProblemInit['extensions']): Response {
  return problem(c, {
    type: 'routine-not-configured',
    title: 'Run now is not set up for this routine',
    status: 409,
    ...(extensions === undefined ? {} : { extensions }),
  });
}

export interface TeamCommandsOptions {
  /** The transport of the fire request; the global `fetch` in the Worker, a fake in specs. */
  readonly routinesFetch?: FetchLike;
  /** Milliseconds; the fire deadline (10 s), shorter in specs. */
  readonly routinesDeadlineMs?: number;
  readonly ownerConnection?: OwnerConnectionSource;
}

/**
 * Team commands, part 1 (#114; architect note on the issue): the team's state from the run log, pause / resume
 * written as `runlog pause` / `runlog resume` write them (on the owner's token), and "Run now", which fires the
 * slot's routine through its own trigger token — one attempt, never retried — after the run log and the 15-minute
 * request lock agree that no run of the slot is in progress or on its way. Run now writes nothing to GitHub, so it
 * does not need the owner connection; pause and resume do.
 */
export function createTeamCommandsRoutes(
  github: ApiGitHub,
  options: TeamCommandsOptions = {},
): Hono<WorkerHonoEnv<ApiEnv>> {
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES });
  const owners = options.ownerConnection ?? connectedOwnerSource(github);
  const baseFetch: FetchLike = options.routinesFetch ?? (async (input, init) => fetch(input, init));

  async function ownerCommand(c: Context, kind: 'pause' | 'resume', reason: string): Promise<Response> {
    const logger = c.get('logger');
    const project = await findProject(c, c.req.param('slug') ?? '');
    if (project === null) {
      return projectNotFound(c);
    }
    const repo = repoOf(c, project);
    if (repo instanceof Response) {
      return repo;
    }
    const installation = await github.connect(c.env);
    const view = await runLogOrProblem(c, installation, repo);
    if (view instanceof Response) {
      return view;
    }
    if (view.issue === null) {
      return runLogMissing(c, 'none');
    }
    const issue = view.issue;
    const fields = { slug: project.slug, command: kind, identity: c.get('identity').kind };
    const writes = new OwnWritesRepo(c.env.DB);
    const bodyHash = await sha256Hex(`${project.repo}\n${issue.number}\n${kind}\n${reason}`);
    const answer = (write: Pick<OwnWrite, 'url'>, state: TeamState, replayed: boolean): Response => {
      const body: TeamCommandResponse = { state, runLogUrl: issue.htmlUrl, commentUrl: write.url, replayed };
      if (replayed) {
        c.header('Idempotent-Replayed', 'true');
      }
      c.header('Cache-Control', 'no-store');
      return c.json(body, replayed ? 200 : 201);
    };

    // A repeat (a retried tap) is answered as it was, but only while the run log still says what it did.
    const recent = await writes.findRecentByHash(
      project.repo,
      issue.number,
      bodyHash,
      iso(github.now() - COMMAND_REPLAY_WINDOW_MS),
    );
    if (recent !== null && view.paused === (kind === 'pause')) {
      logger.info('team command replayed', fields);
      return answer(recent, view.state, true);
    }
    if (kind === 'pause' && issue.author.toLowerCase() !== repo.owner.toLowerCase()) {
      // Fail safe (#141): when the team's bot opened the log, the plugin trusts only the bot's markers, so the next
      // run after an owner /resume can lift a console pause. Until the plugin counts the owner's own markers, a pause
      // that may not hold is refused here and the owner pauses from the team chat. Resume stays allowed.
      logger.warn('console pause refused: run log not opened by the owner', fields);
      return problem(c, {
        type: 'pause-unreliable',
        title: 'Pause from the console is not reliable for this project yet',
        status: 409,
        detail:
          'The run log was opened by the team, not by the owner: pause from the team chat (pause skill)',
      });
    }
    if (kind === 'pause' && view.paused) {
      return problem(c, {
        type: 'team-already-paused',
        title: 'The team is already paused',
        status: 409,
        extensions: { state: view.state, pausedAt: view.ownerPause?.pausedAt ?? null },
      });
    }
    if (kind === 'resume' && !view.paused && view.ownerPause === null) {
      return problem(c, { type: 'team-not-paused', title: 'The team is not paused', status: 409 });
    }
    if (!(await writes.claim(bodyHash, github.now(), COMMAND_REPLAY_WINDOW_MS))) {
      return problem(c, {
        type: 'team-command-in-progress',
        title: 'The same command is being written',
        status: 409,
        retryAfter: 2,
      });
    }

    const now = github.now();
    let isSent = false;
    let comment: GitHubComment;
    try {
      const writer = await ownerWriter(c.env, logger, github, installation, {
        repo,
        registered: project.repo,
      });
      isSent = true;
      // The plugin's order: the label first (what every run checks), then the record.
      if (kind === 'pause') {
        await writer.postJson(
          githubPath`/repos/${repo}/issues/${issue.number}/labels`,
          { labels: [PAUSED_LABEL] },
          isAnything,
        );
      } else if (view.paused) {
        try {
          await writer.delete(githubPath`/repos/${repo}/issues/${issue.number}/labels/${PAUSED_LABEL}`);
        } catch (error: unknown) {
          // Removed meanwhile: resume still records itself, as `runlog resume` does.
          if (!(error instanceof GitHubError && error.problem.type === 'github-not-found')) {
            throw error;
          }
        }
      }
      const body =
        kind === 'pause' ? pauseCommentBody({ reason, source: 'team-console' }, now) : resumeCommentBody(now);
      comment = await writer.postJson(
        githubPath`/repos/${repo}/issues/${issue.number}/comments`,
        { body },
        isComment,
      );
    } catch (error: unknown) {
      if (!isSent || isNotWritten(error)) {
        await writes.release(bodyHash);
      } else {
        logger.warn('team command may have been written; a repeat is held for the replay window', fields);
      }
      throw error;
    }

    const write: OwnWrite = {
      commentId: comment.id,
      repo: project.repo,
      issueNumber: issue.number,
      kind: kind satisfies OwnWriteKind,
      bodyHash,
      url: comment.html_url,
      createdAt: iso(github.now()),
    };
    try {
      await writes.record(write);
      await writes.release(bodyHash);
    } catch (error: unknown) {
      logger.error('team command written but not recorded', { ...fields, error });
    }
    logger.info('team command written', fields);
    return answer(write, kind === 'pause' ? 'paused-by-owner' : 'running', false);
  }

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/team/status', async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const repo = repoOf(c, project);
      if (repo instanceof Response) {
        return repo;
      }
      const nowMs = github.now();
      const view = await runLogOrProblem(c, await github.connect(c.env), repo);
      if (view instanceof Response) {
        return view;
      }
      const requests = new SlotRequestsRepo(c.env.DB);
      const slots: SlotStatusDto[] = [];
      for (const slot of TEAM_SLOTS) {
        let lock = startedLock(view, slot, nowMs);
        if (lock === null) {
          const request = await requests.findLocking(project.slug, slot, requestCutoff(view, slot, nowMs));
          if (request !== null) {
            const until = iso(timeOf(request.requestedAt) + REQUEST_LOCK_MS);
            lock = {
              kind: request.state === 'unknown' ? 'unknown' : 'requested',
              since: request.requestedAt,
              until,
            };
          }
        }
        slots.push({
          slot,
          setup: slotTriggerOf(c.env, project.slug, slot) === null ? 'missing' : 'present',
          secrets: slotSecretNames(project.slug, slot),
          lastRun: lastRunOf(view.runs, slot, nowMs),
          lock,
        });
      }
      const body: TeamStatusDto = {
        state: view.state,
        pausedAt: view.state === 'paused-by-owner' ? (view.ownerPause?.pausedAt ?? null) : null,
        runLogUrl: view.issue?.htmlUrl ?? null,
        ownerConnected: (await owners.current(c.env, c.get('logger'))) !== null,
        environment: c.env.ENVIRONMENT,
        slots,
        checkedAt: iso(nowMs),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/team/pause', ownerOnlyMiddleware, limit, async (c) => {
      const request = parsePause(await jsonBody(c));
      return typeof request === 'string' ? invalid(c, request) : ownerCommand(c, 'pause', request.reason);
    })

    .post('/:slug/team/resume', ownerOnlyMiddleware, limit, async (c) => ownerCommand(c, 'resume', ''))

    .post('/:slug/runs', ownerOnlyMiddleware, limit, async (c) => {
      const logger = c.get('logger');
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const repo = repoOf(c, project);
      if (repo instanceof Response) {
        return repo;
      }
      const request = parseRun(await jsonBody(c));
      if (typeof request === 'string') {
        return invalid(c, request);
      }
      const { slot } = request;
      const trigger = slotTriggerOf(c.env, project.slug, slot);
      if (trigger === null) {
        return notConfigured(c, { missing: missingSlotsOf(c.env, project.slug) });
      }

      // 1–2: the run log, read fresh: paused, or a run of the slot inside the overlap window.
      const nowMs = github.now();
      const view = await runLogOrProblem(c, await github.connect(c.env), repo);
      if (view instanceof Response) {
        return view;
      }
      if (view.paused) {
        return problem(c, {
          type: 'run-paused',
          title: 'Development is paused',
          status: 409,
          detail: 'Resume development first',
        });
      }
      const started = startedLock(view, slot, nowMs);
      if (started?.kind === 'started') {
        return problem(c, {
          type: 'run-in-progress',
          title: 'A run of this slot is in progress',
          status: 409,
          extensions: { runId: started.runId, since: started.since, until: started.until },
        });
      }

      // 3: the request lock, claimed in one statement so two taps never fire twice.
      const requests = new SlotRequestsRepo(c.env.DB);
      const requestedAt = iso(nowMs);
      const cutoff = requestCutoff(view, slot, nowMs);
      const claimed = await requests.claim(project.slug, slot, requestedAt, cutoff);
      if (claimed === null) {
        const locking = await requests.findLocking(project.slug, slot, cutoff);
        const since = locking?.requestedAt ?? requestedAt;
        return problem(c, {
          type: 'run-requested',
          title: 'This run was requested already',
          status: 409,
          extensions: {
            since,
            until: iso(timeOf(since) + REQUEST_LOCK_MS),
            lock: locking?.state === 'unknown' ? 'unknown' : 'requested',
          },
        });
      }
      await requests.prune(iso(nowMs - PRUNE_AFTER_MS));

      const fields = { slug: project.slug, slot, identity: c.get('identity').kind };
      const client = new RoutinesClient(
        routinesFetch(c.env, baseFetch),
        options.routinesDeadlineMs === undefined ? {} : { deadlineMs: options.routinesDeadlineMs },
      );
      let outcome: FireOutcome;
      try {
        outcome = await client.fire({
          routineId: trigger.routineId,
          token: trigger.token,
          text: `product=${project.slug} repo=${project.repo} slot=${RUN_LOG_SLOTS[slot]} source=team-console requested_at=${requestedAt}`,
        });
      } catch (error: unknown) {
        await requests.release(claimed);
        if (error instanceof InvalidRoutineConfigError) {
          logger.warn('routine secret malformed', { ...fields, part: error.part });
          return notConfigured(c, { step: error.part });
        }
        throw error;
      }
      logger.info('routine fire answered', { ...fields, outcome: outcome.kind });

      const until = iso(nowMs + REQUEST_LOCK_MS);
      switch (outcome.kind) {
        case 'fired': {
          await requests.settle(claimed, 'fired', outcome.sessionId);
          const body: RunResponse = {
            slot,
            requestedAt,
            lockedUntil: until,
            runLogUrl: view.issue?.htmlUrl ?? null,
          };
          c.header('Cache-Control', 'no-store');
          return c.json(body, 202);
        }
        case 'unknown':
          await requests.settle(claimed, 'unknown', null);
          return problem(c, {
            type: 'routine-unknown',
            title: 'The run service did not answer',
            status: 504,
            detail: 'It is unknown whether the run started',
            extensions: { until },
          });
        default:
          break;
      }
      // Every other answer is a refusal before any session: nothing started, the slot is free again.
      await requests.release(claimed);
      switch (outcome.kind) {
        case 'rate-limited':
          return problem(c, {
            type: 'routine-rate-limited',
            title: 'Run limit reached',
            status: 429,
            detail: 'At most 30 per hour for this routine, or 100 per hour for the account',
            retryAfter: outcome.retryAfter,
          });
        case 'paused':
          return problem(c, {
            type: 'routine-paused',
            title: 'The routine is switched off in Claude Code',
            status: 409,
            detail: 'Switch it on at claude.ai/code/routines',
          });
        case 'unauthorized':
          return notConfigured(c, { step: 'token' });
        case 'not-found':
          return notConfigured(c, { step: 'routine' });
        case 'unavailable':
          return problem(c, {
            type: 'routine-unavailable',
            title: 'The run service is unavailable',
            status: 502,
            detail: `The run service answered ${outcome.status}`,
          });
      }
    });
}
