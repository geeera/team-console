import { Hono } from 'hono';
import {
  RUNNER_CHECKS_PER_ACCOUNT_PER_HOUR,
  RUNNER_CHECKS_PER_RUNNER_PER_HOUR,
  RUNNER_ONLINE_WINDOW_SECONDS,
  checkFinishRunnerCheckInput,
  checkStartRunnerCheckInput,
  isRunnerId,
  isUlid,
  type RunnerCheckDto,
  type RunnerCheckKind,
  type RunnerCheckRefusal,
} from '@shared/contracts';
import {
  newUlid,
  problem,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import {
  RunnerChecksRepo,
  RunnersRepo,
  type AccountRecord,
  type RunnerCheckRecord,
  type RunnerRecord,
} from '@worker/db';
import { auditActorOf } from '../auth/scope';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { ownedAccountOf } from './accounts';
import { runnerPauseOf } from './runner-pause';
import { runnerOf } from './runner-jobs';

type Context = WorkerContext<ApiEnv>;

/**
 * Runner checks (#1059; architect note §1–§3, security note S1–S12). The owner's two routes are owner-of-account
 * (`account` in the route inventory, so a member is 403 and the service identity 404) and judge in this order (T10):
 * the account scope, the runner in that account (404, the same body as a runner that does not exist), then the
 * runner's state. The runner's `finish` takes its runner and account from the JWT alone; anything that is not its own
 * live check is one 404. A check never touches `jobs`, `team_state`, budgets, concurrency or placement.
 */

function runnerNotFound(c: Context): Response {
  return problem(c, { type: 'runner-not-found', title: 'Runner not found', status: 404 });
}

function checkNotFound(c: Context): Response {
  return problem(c, { type: 'runner-check-not-found', title: 'Runner check not found', status: 404 });
}

/** A 422 that names the field and never echoes what was sent (S5). */
function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

function refused(c: Context, type: RunnerCheckRefusal, status: 409 | 422, detail: string): Response {
  c.get('logger').info('runner check refused', { reason: type });
  return problem(c, { type, title: status === 409 ? 'Conflict' : 'Invalid request', status, detail });
}

export function runnerCheckDtoOf(check: RunnerCheckRecord): RunnerCheckDto {
  return {
    id: check.id,
    kind: check.kind,
    state: check.state,
    reason: check.reason,
    claudeVersion: check.claudeVersion,
    createdAt: check.createdAt,
    pickedAt: check.pickedAt,
    finishedAt: check.finishedAt,
  };
}

/** The account's runner behind `:runner`, or the 404 another account's runner and a missing one share. */
async function runnerInAccountOf(c: Context, account: AccountRecord): Promise<RunnerRecord | Response> {
  const runnerId = c.req.param('runner') ?? '';
  const runner = isRunnerId(runnerId)
    ? await new RunnersRepo(c.env.DB).findInAccount(account.id, runnerId)
    : null;
  return runner ?? runnerNotFound(c);
}

/** Why this runner cannot take a check now, in the order the owner fixes them; `null` when it can (§2). */
function refusalOf(c: Context, runner: RunnerRecord, kind: RunnerCheckKind, now: Date): Response | null {
  if (runner.revokedAt !== null) {
    return refused(c, 'runner-revoked', 409, 'The runner is revoked');
  }
  if (
    runner.hosted ||
    runner.isolation === 'actions-ephemeral' ||
    (runner.isolation === 'none' && c.env.ENVIRONMENT === 'production')
  ) {
    return refused(c, 'runner-check-unsupported', 422, 'This runner cannot run a check');
  }
  if (runnerPauseOf(runner, now) !== null) {
    return refused(c, 'runner-paused', 409, 'The runner is paused');
  }
  const online =
    runner.lastSeenAt !== null &&
    now.getTime() - Date.parse(runner.lastSeenAt) <= RUNNER_ONLINE_WINDOW_SECONDS * 1000;
  if (!online) {
    return refused(c, 'runner-offline', 409, 'The runner is not online');
  }
  if (runner.capabilities.checks?.includes(kind) !== true) {
    return refused(c, 'runner-outdated', 409, 'This runner release cannot run the check; update the runner');
  }
  return null;
}

/** `POST …/accounts/:id/runners/:runner/checks` and `GET …/checks/:check`. */
export function createAccountRunnerCheckRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/:id/runners/:runner/checks', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const runner = await runnerInAccountOf(c, account);
      if (runner instanceof Response) {
        return runner;
      }
      const input = checkStartRunnerCheckInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'runner-check-invalid', input.field, input.detail);
      }
      const now = new Date();
      const at = now.toISOString();
      const checks = new RunnerChecksRepo(c.env.DB);
      await checks.expireStale(account.id, runner.id, at);
      // A double click or a second tab converges on the check in flight (S12); a replay creates and counts nothing.
      const live = await checks.findLive(account.id, runner.id);
      if (live !== null) {
        return c.json(runnerCheckDtoOf(live), 200);
      }
      const refusal = refusalOf(c, runner, input.value.kind, now);
      if (refusal !== null) {
        return refusal;
      }
      const actor = auditActorOf(c.get('identity'));
      const outcome = await checks.create(
        {
          id: newUlid(now.getTime()),
          accountId: account.id,
          runnerId: runner.id,
          kind: input.value.kind,
          at,
        },
        { actorKind: actor.kind, actor: actor.actor, ipCountry: c.req.header('CF-IPCountry') ?? null },
        { perRunner: RUNNER_CHECKS_PER_RUNNER_PER_HOUR, perAccount: RUNNER_CHECKS_PER_ACCOUNT_PER_HOUR },
      );
      switch (outcome.kind) {
        case 'created':
          c.get('logger').info('runner check requested', { checkId: outcome.check.id, runnerId: runner.id });
          return c.json(runnerCheckDtoOf(outcome.check), 201);
        case 'live':
          return c.json(runnerCheckDtoOf(outcome.check), 200);
        case 'rate-limited':
          // Logged, never audited (T8): a script in a loop must not grow the append-only table.
          c.get('logger').warn('runner check refused', { reason: 'rate-limited', runnerId: runner.id });
          return problem(c, {
            type: 'rate-limited',
            title: 'Too Many Requests',
            status: 429,
            retryAfter: outcome.retryAfterSeconds,
          });
        case 'refused': {
          // The row changed between the read and the write: word the refusal from the row as it is now.
          const current = await new RunnersRepo(c.env.DB).findInAccount(account.id, runner.id);
          return (
            (current === null ? runnerNotFound(c) : refusalOf(c, current, input.value.kind, now)) ??
            refused(c, 'runner-outdated', 409, 'This runner release cannot run the check; update the runner')
          );
        }
      }
    })

    .get('/:id/runners/:runner/checks/:check', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const runner = await runnerInAccountOf(c, account);
      if (runner instanceof Response) {
        return runner;
      }
      const checkId = c.req.param('check');
      if (!isUlid(checkId)) {
        return checkNotFound(c);
      }
      const checks = new RunnerChecksRepo(c.env.DB);
      await checks.expireStale(account.id, runner.id, new Date().toISOString());
      // By id, runner and account together (S9): R1's check read through R2's path does not exist.
      const check = await checks.findOfRunner(account.id, runner.id, checkId);
      return check === null ? checkNotFound(c) : c.json(runnerCheckDtoOf(check));
    });
}

/** `POST /api/v1/runner/checks/:id/finish` (S5, T2). */
export function createRunnerCheckRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().post(
    '/checks/:id/finish',
    writeLimit(SMALL_WRITE_MAX_BYTES),
    async (c) => {
      const runner = runnerOf(c);
      const checkId = c.req.param('id');
      const checks = new RunnerChecksRepo(c.env.DB);
      const check = isUlid(checkId)
        ? await checks.findOfRunner(runner.accountId, runner.runnerId, checkId)
        : null;
      if (check === null) {
        return checkNotFound(c);
      }
      const input = checkFinishRunnerCheckInput(await jsonBody(c));
      if (!input.ok) {
        c.get('logger').warn('runner check finish refused', { reason: 'invalid', field: input.field });
        return invalid(c, 'runner-check-finish-invalid', input.field, input.detail);
      }
      const at = new Date().toISOString();
      // A finish past the running window finds the check `lost` (the sweep runs first) and gets the same 404; the
      // UPDATE re-judges the window itself, so a finish racing the sweep cannot overwrite it either.
      await checks.expireStale(runner.accountId, runner.runnerId, at);
      const finished = await checks.finish(check, input.value, at, c.req.header('CF-IPCountry') ?? null);
      if (!finished) {
        return checkNotFound(c);
      }
      c.get('logger').info('runner check finished', {
        checkId: check.id,
        runnerId: runner.runnerId,
        result: input.value.result,
      });
      return c.body(null, 204);
    },
  );
}
