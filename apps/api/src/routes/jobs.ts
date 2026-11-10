import { Hono } from 'hono';
import {
  JOB_MAX_MINUTES_DEFAULT,
  checkCreateJobInput,
  checkRunnerPolicy,
  isJobState,
  isUlid,
  roleOfJobKind,
  runnerIdsOfPolicy,
  type JobDto,
  type JobEventListDto,
  type JobListDto,
  type RunnerPolicyDto,
} from '@shared/contracts';
import { newUlid, problem, type ProblemExtensionValue, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { AccountsRepo, JobsRepo, RunnersRepo, effectivePolicyOf, type JobRecord, type NewAuditEvent } from '@worker/db';
import { isJobRole } from '../auth/job-roles';
import { auditActorOf } from '../auth/scope';
import { trackerAccess, trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { trackerProjectOf } from '../projects/lookup';
import { trackerWriteRefusal } from '../tracker/context';
import { PAGE_MAX, SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';

type Context = WorkerContext<ApiEnv>;

const P = '/api/v1/projects/:slug';
const PAGE_DEFAULT = 50;
const CURSOR = /^(0|[1-9][0-9]{0,15})$/;

function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

export function jobDtoOf(job: JobRecord): JobDto {
  const items = job.payload['items'];
  return {
    id: job.id,
    projectSlug: job.projectSlug,
    kind: job.kind,
    role: job.role,
    state: job.state,
    items: Array.isArray(items) ? items.filter((n): n is number => typeof n === 'number') : [],
    priority: job.priority,
    requestedBy: job.requestedBy,
    needsLocal: job.needsLocal,
    dispatch: job.dispatch,
    runnerId: job.runnerId,
    attempt: job.attempt,
    maxMinutes: job.maxMinutes,
    createdAt: job.createdAt,
    claimedAt: job.claimedAt,
    leaseUntil: job.leaseUntil,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
  };
}

function limitOf(c: Context): number | Response {
  const limit = c.req.query('limit') ?? String(PAGE_DEFAULT);
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > PAGE_MAX) {
    return problem(c, { type: 'query-invalid', title: 'Invalid request', status: 400, detail: `limit is 1 to ${String(PAGE_MAX)}` });
  }
  return Number(limit);
}

/** The slug of a slot job, so one slot per project is live at a time (ADR 0006: the overlap guard). */
function dedupeKeyOf(slug: string, kind: string): string | null {
  return kind.startsWith('slot-') || kind === 'burn' || kind === 'import' ? `${slug}:${kind}` : null;
}

function auditOf(c: Context, accountId: string, at: string, kind: NewAuditEvent['kind'], target: string, details: Readonly<Record<string, unknown>>): NewAuditEvent {
  const actor = auditActorOf(c.get('identity'));
  return { accountId, at, actorKind: actor.kind, actor: actor.actor, kind, target, details, ipCountry: c.req.header('CF-IPCountry') ?? null };
}

/**
 * `POST|GET /api/v1/projects/:slug/jobs`, `GET …/jobs/:id`, `GET …/jobs/:id/events`, `GET|PUT …/runner-policy`
 * (#467, ADR 0008 row 2-A): the queue behind the route matrix (the owner enqueues; the owner, a member and the
 * project's own job read), D1 only. Run now carries no `Idempotency-Key`: the dedupe key answers a repeat with 409
 * `job-exists` while the first is live. Placement (ADR 0008 decision 12) is written per project here and per account
 * in `account-runners.ts`; a policy naming another account's runner is 422 `runner-policy-invalid`.
 */
export function createJobRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/:slug/jobs', trackerAccess(`POST ${P}/jobs`), writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const row = trackerProjectOfContext(c);
      const refusal = trackerWriteRefusal(c, trackerProjectOf(row));
      if (refusal !== null) {
        return refusal;
      }
      const input = checkCreateJobInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'job-invalid', input.field, input.detail);
      }
      const { value } = input;
      const role = roleOfJobKind(value.kind, value.role);
      if (!isJobRole(role)) {
        return invalid(c, 'job-invalid', 'role', 'role must be a role the matrix knows');
      }
      const now = new Date();
      const at = now.toISOString();
      const id = newUlid(now.getTime());
      const outcome = await new JobsRepo(c.env.DB).enqueue(
        {
          id,
          accountId: row.account_id,
          projectSlug: row.slug,
          kind: value.kind,
          role,
          payload: { items: value.items },
          priority: 1,
          requestedBy: 'owner',
          dedupeKey: dedupeKeyOf(row.slug, value.kind),
          needsLocal: value.needsLocal,
          maxMinutes: value.maxMinutes ?? JOB_MAX_MINUTES_DEFAULT,
          at,
        },
        auditOf(c, row.account_id, at, 'job.dispatched', id, { kind: value.kind, role, items: value.items, slug: row.slug }),
      );
      if (outcome === 'job-exists') {
        return problem(c, { type: 'job-exists', title: 'Conflict', status: 409, detail: 'A job of this kind is already queued or running for the project' });
      }
      const job = await new JobsRepo(c.env.DB).findInProject(row.slug, id);
      return c.json(job === null ? null : jobDtoOf(job), 201);
    })

    .get('/:slug/jobs', trackerAccess(`GET ${P}/jobs`), async (c) => {
      const row = trackerProjectOfContext(c);
      const limit = limitOf(c);
      if (limit instanceof Response) {
        return limit;
      }
      const state = c.req.query('state');
      const after = c.req.query('after');
      if ((state !== undefined && !isJobState(state)) || (after !== undefined && !isUlid(after))) {
        return problem(c, { type: 'query-invalid', title: 'Invalid request', status: 400 });
      }
      const rows = await new JobsRepo(c.env.DB).listForProject(row.slug, {
        ...(state === undefined ? {} : { state }),
        after: after ?? null,
        limit,
      });
      const page = rows.slice(0, limit);
      const body: JobListDto = { jobs: page.map(jobDtoOf), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
      return c.json(body);
    })

    .get('/:slug/jobs/:id', trackerAccess(`GET ${P}/jobs/:id`), async (c) => {
      const row = trackerProjectOfContext(c);
      const id = c.req.param('id');
      const job = isUlid(id) ? await new JobsRepo(c.env.DB).findInProject(row.slug, id) : null;
      return job === null ? problem(c, { type: 'job-not-found', title: 'Job not found', status: 404 }) : c.json(jobDtoOf(job));
    })

    .get('/:slug/jobs/:id/events', trackerAccess(`GET ${P}/jobs/:id/events`), async (c) => {
      const row = trackerProjectOfContext(c);
      const id = c.req.param('id');
      const repo = new JobsRepo(c.env.DB);
      const job = isUlid(id) ? await repo.findInProject(row.slug, id) : null;
      if (job === null) {
        return problem(c, { type: 'job-not-found', title: 'Job not found', status: 404 });
      }
      const limit = limitOf(c);
      if (limit instanceof Response) {
        return limit;
      }
      const after = c.req.query('after') ?? '0';
      if (!CURSOR.test(after)) {
        return problem(c, { type: 'query-invalid', title: 'Invalid request', status: 400 });
      }
      const rows = await repo.listEvents(job.id, Number(after), limit);
      const page = rows.slice(0, limit);
      const body: JobEventListDto = { events: page, nextCursor: rows.length > limit ? (page.at(-1)?.seq ?? null) : null };
      return c.json(body);
    })

    .get('/:slug/runner-policy', trackerAccess(`GET ${P}/runner-policy`), async (c) => {
      const row = trackerProjectOfContext(c);
      const account = await new AccountsRepo(c.env.DB).findById(row.account_id);
      const body: RunnerPolicyDto = {
        policy: row.runner_policy === null ? null : effectivePolicyOf(row.runner_policy, null),
        effective: effectivePolicyOf(row.runner_policy, account?.defaultRunnerPolicy ?? null),
      };
      return c.json(body);
    })

    .put('/:slug/runner-policy', trackerAccess(`PUT ${P}/runner-policy`), writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const row = trackerProjectOfContext(c);
      const body = await jsonBody(c);
      const policy = body === null ? null : checkRunnerPolicy(body);
      if (policy !== null && !policy.ok) {
        return invalid(c, 'runner-policy-invalid', policy.field, policy.detail);
      }
      const value = policy === null ? null : policy.value;
      if (value !== null) {
        const live = await new RunnersRepo(c.env.DB).liveIdsOf(row.account_id);
        if (!runnerIdsOfPolicy(value).every((id) => live.includes(id))) {
          return invalid(c, 'runner-policy-invalid', 'runner', 'The policy must name unrevoked runners of this account');
        }
      }
      const at = new Date().toISOString();
      await new AccountsRepo(c.env.DB).setProjectRunnerPolicy(
        row.slug,
        value === null ? null : JSON.stringify(value),
        auditOf(c, row.account_id, at, 'runner.policy-changed', row.slug, { scope: 'project', policy: value }),
      );
      const account = await new AccountsRepo(c.env.DB).findById(row.account_id);
      const dto: RunnerPolicyDto = {
        policy: value,
        effective: effectivePolicyOf(value === null ? null : JSON.stringify(value), account?.defaultRunnerPolicy ?? null),
      };
      return c.json(dto);
    });
}
