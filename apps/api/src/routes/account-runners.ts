import { Hono } from 'hono';
import {
  ENROLMENT_CODE_TTL_SECONDS,
  RUNNER_ONLINE_WINDOW_SECONDS,
  checkCreateEnrolmentCodeInput,
  checkRunnerPolicy,
  checkUpdateRunnerInput,
  isEnrolmentId,
  isRunnerId,
  isRunnerVersionBelow,
  runnerAudienceOf,
  runnerIdsOfPolicy,
  type EnrolmentCodeDto,
  type PendingEnrolmentDto,
  type RunnerDto,
  type RunnerListDto,
  type RunnerPolicyDto,
} from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX } from '@shared/redaction';
import {
  problem,
  randomOpaqueToken,
  sha256Hex,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import {
  AccountsRepo,
  JobsRepo,
  ProjectsRepo,
  RunnersRepo,
  effectivePolicyOf,
  type AccountRecord,
  type EnrolmentRecord,
  type NewAuditEvent,
  type RunnerRecord,
} from '@worker/db';
import { auditActorOf } from '../auth/scope';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { ownedAccountOf } from './accounts';
import { runnerReleaseOf } from './runner';

type Context = WorkerContext<ApiEnv>;

function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

function runnerNotFound(c: Context): Response {
  return problem(c, { type: 'runner-not-found', title: 'Runner not found', status: 404 });
}

/** A 256-bit one-time code under the prefix the redactor knows, so it never survives in a log or an audit row. */
function newEnrolmentCode(): string {
  return randomOpaqueToken(ENROLMENT_CODE_PREFIX);
}

/**
 * The slugs that are not active projects of the account (ADR 0008 security re-review: an `allowed_projects` write
 * rejects another account's slugs — and an archived or unknown one — before anything is stored).
 */
async function foreignSlugsOf(c: Context, account: AccountRecord, slugs: readonly string[]): Promise<string[]> {
  const own = new Set((await new ProjectsRepo(c.env.DB).listActive([account.id])).map((row) => row.slug));
  return slugs.filter((slug) => !own.has(slug));
}

export function runnerDtoOf(runner: RunnerRecord, now: Date, minimumVersion: string | null): RunnerDto {
  const online =
    runner.revokedAt === null &&
    runner.lastSeenAt !== null &&
    now.getTime() - Date.parse(runner.lastSeenAt) <= RUNNER_ONLINE_WINDOW_SECONDS * 1000;
  return {
    id: runner.id,
    name: runner.name,
    isolation: runner.isolation,
    hosted: runner.hosted,
    version: runner.version,
    pinnedVersion: runner.pinnedVersion,
    host: runner.host,
    capabilities: runner.capabilities,
    allowedProjects: runner.allowedProjects,
    enrolledAt: runner.enrolledAt,
    lastSeenAt: runner.lastSeenAt,
    lastSeenCountry: runner.lastSeenCountry,
    online,
    suspect:
      runner.suspectAt !== null && runner.suspectReason !== null
        ? { at: runner.suspectAt, reason: runner.suspectReason }
        : null,
    revokedAt: runner.revokedAt,
    belowMinimum: isRunnerVersionBelow(runner.version, minimumVersion),
  };
}

function pendingEnrolmentDtoOf(enrolment: EnrolmentRecord): PendingEnrolmentDto {
  return {
    id: enrolment.codeHash,
    name: enrolment.name,
    allowedProjects: enrolment.allowedProjects,
    createdAt: enrolment.createdAt,
    expiresAt: enrolment.expiresAt,
  };
}

function auditOf(
  c: Context,
  account: AccountRecord,
  at: string,
  kind: NewAuditEvent['kind'],
  target: string,
  details: Readonly<Record<string, unknown>>,
): NewAuditEvent {
  const actor = auditActorOf(c.get('identity'));
  return {
    accountId: account.id,
    at,
    actorKind: actor.kind,
    actor: actor.actor,
    kind,
    target,
    details,
    ipCountry: c.req.header('CF-IPCountry') ?? null,
  };
}

/**
 * `POST /api/v1/accounts/:id/runners/enrolment-code`, `GET …/runners`, `PATCH …/runners/:runner`,
 * `POST …/runners/:runner/revoke` (#467, ADR 0008 row 2-A): owner-of-account, as every account route. A runner of
 * another account is 404 `runner-not-found`, the same as one that does not exist; an allowed-projects list names
 * the account's own active projects only. Every change is an `audit_events` row in the change's batch.
 */
export function createAccountRunnerRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/:id/runners/enrolment-code', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const input = checkCreateEnrolmentCodeInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'enrolment-code-invalid-input', input.field, input.detail);
      }
      const foreign = await foreignSlugsOf(c, account, input.value.allowedProjects);
      if (foreign.length > 0) {
        return invalid(
          c,
          'allowed-projects-invalid',
          'allowedProjects',
          'allowedProjects must name active projects of this account',
        );
      }
      const now = new Date();
      const at = now.toISOString();
      const expiresAt = new Date(now.getTime() + ENROLMENT_CODE_TTL_SECONDS * 1000).toISOString();
      const code = newEnrolmentCode();
      await new RunnersRepo(c.env.DB).createEnrolment(
        {
          codeHash: await sha256Hex(code),
          accountId: account.id,
          name: input.value.name,
          allowedProjects: input.value.allowedProjects,
          createdBy: auditActorOf(c.get('identity')).actor,
          at,
          expiresAt,
        },
        auditOf(c, account, at, 'enrolment-code.created', 'enrolment-code', {
          name: input.value.name,
          allowedProjects: input.value.allowedProjects,
          expiresAt,
        }),
      );
      c.get('logger').info('enrolment code created', { accountId: account.id });
      const body: EnrolmentCodeDto = {
        code,
        expiresAt,
        apiUrl: new URL(c.req.url).origin,
        audience: runnerAudienceOf(c.env.ENVIRONMENT),
        name: input.value.name,
        allowedProjects: input.value.allowedProjects,
      };
      return c.json(body, 201);
    })

    // Placement (ADR 0008 decision 12): the account default a project without its own policy falls back to.
    .get('/:id/runner-policy', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const body: RunnerPolicyDto = {
        policy: account.defaultRunnerPolicy === null ? null : effectivePolicyOf(account.defaultRunnerPolicy, null),
        effective: effectivePolicyOf(account.defaultRunnerPolicy, null),
      };
      return c.json(body);
    })

    .put('/:id/runner-policy', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const body = await jsonBody(c);
      const policy = body === null ? null : checkRunnerPolicy(body);
      if (policy !== null && !policy.ok) {
        return invalid(c, 'runner-policy-invalid', policy.field, policy.detail);
      }
      const value = policy === null ? null : policy.value;
      if (value !== null) {
        const live = await new RunnersRepo(c.env.DB).liveIdsOf(account.id);
        if (!runnerIdsOfPolicy(value).every((id) => live.includes(id))) {
          return invalid(c, 'runner-policy-invalid', 'runner', 'The policy must name unrevoked runners of this account');
        }
      }
      const json = value === null ? null : JSON.stringify(value);
      await new AccountsRepo(c.env.DB).setDefaultRunnerPolicy(
        account.id,
        json,
        auditOf(c, account, new Date().toISOString(), 'runner.policy-changed', account.id, { scope: 'account', policy: value }),
      );
      const dto: RunnerPolicyDto = { policy: value, effective: effectivePolicyOf(json, null) };
      return c.json(dto);
    })

    .get('/:id/runners', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const now = new Date();
      const release = runnerReleaseOf(c.env);
      const runners = new RunnersRepo(c.env.DB);
      const body: RunnerListDto = {
        runners: (await runners.listForAccount(account.id)).map((runner) =>
          runnerDtoOf(runner, now, release.minimumVersion),
        ),
        pendingEnrolments: (await runners.listPendingEnrolments(account.id, now.toISOString())).map(
          pendingEnrolmentDtoOf,
        ),
        release,
      };
      return c.json(body);
    })

    // #492: the owner withdraws a code before its ten minutes are up (shown on a screen, pasted in the wrong place).
    .post('/:id/runners/enrolment-codes/:enrolment/withdraw', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const enrolmentId = c.req.param('enrolment');
      const at = new Date().toISOString();
      // One 404 for a malformed id, another account's code, a used, an expired or an already withdrawn one.
      const withdrawn =
        isEnrolmentId(enrolmentId) &&
        (await new RunnersRepo(c.env.DB).withdrawEnrolment(
          account.id,
          enrolmentId,
          at,
          auditOf(c, account, at, 'enrolment-code.withdrawn', 'enrolment-code', {}),
        ));
      if (!withdrawn) {
        return problem(c, { type: 'enrolment-not-found', title: 'Enrolment code not found', status: 404 });
      }
      c.get('logger').info('enrolment code withdrawn', { accountId: account.id });
      return c.body(null, 204);
    })

    .post('/:id/runners/:runner/clear-suspect', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const runnerId = c.req.param('runner');
      const runners = new RunnersRepo(c.env.DB);
      const runner = isRunnerId(runnerId) ? await runners.findInAccount(account.id, runnerId) : null;
      if (runner === null) {
        return runnerNotFound(c);
      }
      if (runner.revokedAt !== null) {
        return problem(c, { type: 'runner-revoked', title: 'Conflict', status: 409, detail: 'The runner is revoked' });
      }
      const now = new Date();
      // The read above words the refusal; the conditional write decides, so a concurrent clear audits once.
      const cleared =
        runner.suspectAt !== null &&
        (await runners.clearSuspect(
          account.id,
          runner.id,
          auditOf(c, account, now.toISOString(), 'runner.suspect-cleared', runner.id, {
            reason: runner.suspectReason,
            suspectAt: runner.suspectAt,
          }),
        ));
      if (!cleared) {
        return problem(c, { type: 'runner-not-suspect', title: 'Conflict', status: 409, detail: 'The runner is not marked suspect' });
      }
      const updated = await runners.findInAccount(account.id, runner.id);
      return c.json(runnerDtoOf(updated ?? runner, now, runnerReleaseOf(c.env).minimumVersion));
    })

    .patch('/:id/runners/:runner', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const runnerId = c.req.param('runner');
      const runners = new RunnersRepo(c.env.DB);
      const runner = isRunnerId(runnerId) ? await runners.findInAccount(account.id, runnerId) : null;
      if (runner === null) {
        return runnerNotFound(c);
      }
      const input = checkUpdateRunnerInput(await jsonBody(c));
      if (!input.ok) {
        return invalid(c, 'runner-invalid', input.field, input.detail);
      }
      const foreign = await foreignSlugsOf(c, account, input.value.allowedProjects);
      if (foreign.length > 0) {
        return invalid(
          c,
          'allowed-projects-invalid',
          'allowedProjects',
          'allowedProjects must name active projects of this account',
        );
      }
      const now = new Date();
      // Narrowing the list cancels the runner's live jobs in the projects it loses, in the same batch (#490 review).
      await runners.setAllowedProjects(
        account.id,
        runner.id,
        input.value.allowedProjects,
        auditOf(c, account, now.toISOString(), 'runner.updated', runner.id, {
          allowedProjects: input.value.allowedProjects,
          before: runner.allowedProjects,
        }),
        new JobsRepo(c.env.DB).cancelOutsideStatements(runner.id, input.value.allowedProjects, now.toISOString()),
      );
      const updated = await runners.findInAccount(account.id, runner.id);
      return c.json(runnerDtoOf(updated ?? runner, now, runnerReleaseOf(c.env).minimumVersion));
    })

    .post('/:id/runners/:runner/revoke', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const runnerId = c.req.param('runner');
      const runners = new RunnersRepo(c.env.DB);
      const runner = isRunnerId(runnerId) ? await runners.findInAccount(account.id, runnerId) : null;
      if (runner === null) {
        return runnerNotFound(c);
      }
      if (runner.revokedAt !== null) {
        return problem(c, {
          type: 'runner-revoked',
          title: 'Conflict',
          status: 409,
          detail: 'The runner is already revoked',
        });
      }
      const now = new Date();
      const at = now.toISOString();
      // ADR 0006: revoking a runner cancels the jobs it holds, in the same batch (their tokens die with it).
      const revoked = await runners.revoke(
        account.id,
        runner.id,
        at,
        auditOf(c, account, at, 'runner.revoked', runner.id, { name: runner.name }),
        new JobsRepo(c.env.DB).cancelForRunnerStatements(runner.id, at),
      );
      if (!revoked) {
        return problem(c, { type: 'runner-revoked', title: 'Conflict', status: 409 });
      }
      c.get('logger').info('runner revoked', { runnerId: runner.id });
      const updated = await runners.findInAccount(account.id, runner.id);
      return c.json(runnerDtoOf(updated ?? runner, now, runnerReleaseOf(c.env).minimumVersion));
    });
}
