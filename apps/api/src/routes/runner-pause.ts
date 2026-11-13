import { Hono } from 'hono';
import { checkPauseRunnerInput, type RunnerPauseDto } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { RunnersRepo, type NewAuditEvent, type RunnerRecord } from '@worker/db';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { runnerOf, type RunnerIdentity } from './runner-jobs';

type Context = WorkerContext<ApiEnv>;

/** The pause in force at `now`: a row whose `until` has passed is no pause, whatever it still holds. */
export function runnerPauseOf(runner: Pick<RunnerRecord, 'pause'>, now: Date): RunnerPauseDto | null {
  return runner.pause !== null && Date.parse(runner.pause.until) > now.getTime() ? runner.pause : null;
}

/** The answer of both routes: the runner's pause as the claim now judges it. */
export interface RunnerPauseResponse {
  readonly pause: RunnerPauseDto | null;
}

function auditOf(
  c: Context,
  runner: RunnerIdentity,
  at: string,
  kind: NewAuditEvent['kind'],
  details: Readonly<Record<string, unknown>>,
): NewAuditEvent {
  const country = c.req.header('CF-IPCountry') ?? null;
  return { accountId: runner.accountId, at, actorKind: 'runner', actor: runner.runnerId, kind, target: runner.runnerId, details, ipCountry: country };
}

/** Reads the runner back after a write; a runner revoked since authentication answers as the runner door does. */
async function answerOf(c: Context, runner: RunnerIdentity, now: Date): Promise<Response> {
  const stored = await new RunnersRepo(c.env.DB).findInAccount(runner.accountId, runner.runnerId);
  if (stored === null || stored.revokedAt !== null) {
    c.get('logger').warn('runner rejected', { reason: 'runner-revoked' });
    return problem(c, { type: 'runner-revoked', title: 'Unauthorized', status: 401 });
  }
  const body: RunnerPauseResponse = { pause: runnerPauseOf(stored, now) };
  return c.json(body);
}

/**
 * `POST /api/v1/runner/pause` and `POST /api/v1/runner/resume` (#571, ADR 0008 decision 9; architect note on #468,
 * PR 4). The runner enforces its usage budget and mirrors its local pause here, so the claim skips it and Settings ›
 * Runners shows why and until when. The runner JWT alone is the credential (`runner-auth.ts`); a runner pauses only
 * itself, inside its own account — the id and the account come from the identity, never from the body. `until` is at
 * most 24 h ahead, so a pause always lapses on its own; a repeated post changes nothing and audits nothing.
 */
export function createRunnerPauseRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/pause', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const runner = runnerOf(c);
      const now = new Date();
      const input = checkPauseRunnerInput(await jsonBody(c), now);
      if (!input.ok) {
        const extensions: Record<string, ProblemExtensionValue> = { field: input.field };
        return problem(c, { type: 'runner-pause-invalid', title: 'Invalid request', status: 422, detail: input.detail, extensions });
      }
      const at = now.toISOString();
      const changed = await new RunnersRepo(c.env.DB).pause(
        runner.accountId,
        runner.runnerId,
        input.value,
        auditOf(c, runner, at, 'runner.paused', { reason: input.value.reason }),
      );
      if (changed) {
        c.get('logger').info('runner paused', { runnerId: runner.runnerId, reason: input.value.reason, until: input.value.until });
      }
      return answerOf(c, runner, now);
    })

    .post('/resume', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const runner = runnerOf(c);
      const now = new Date();
      const changed = await new RunnersRepo(c.env.DB).resume(
        runner.accountId,
        runner.runnerId,
        auditOf(c, runner, now.toISOString(), 'runner.resumed', {}),
      );
      if (changed) {
        c.get('logger').info('runner resumed', { runnerId: runner.runnerId });
      }
      return answerOf(c, runner, now);
    });
}
