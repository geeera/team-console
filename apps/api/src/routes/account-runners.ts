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
  runnerTakesSubscription,
  type EnrolmentCodeDto,
  type PendingEnrolmentDto,
  type RunnerDto,
  type RunnerEnrollerState,
  type RunnerListDto,
  type RunnerPolicyDto,
  type RunnerProjectScopeDto,
  type RunnerServedProjectDto,
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
  RunnerChecksRepo,
  RunnersRepo,
  effectivePolicyOf,
  type AccountRecord,
  type EnrolmentRecord,
  type NewAuditEvent,
  type RunnerRecord,
  type ServedProjectRecord,
} from '@worker/db';
import { auditActorOf } from '../auth/scope';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { ownedAccountOf } from './accounts';
import { accessSourceHosted } from './jobs';
import { runnerReleaseOf } from './runner';
import { runnerPauseOf } from './runner-pause';

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
export async function foreignSlugsOf(
  c: Context,
  account: AccountRecord,
  slugs: readonly string[],
): Promise<string[]> {
  const own = new Set((await new ProjectsRepo(c.env.DB).listActive([account.id])).map((row) => row.slug));
  return slugs.filter((slug) => !own.has(slug));
}

/**
 * The projects the runner serves now with the fit of its declared `accessSources` (#775): a runner that declares
 * nothing fits everything (nothing to compare); one that declares a source fits the projects on that source.
 */
export function servedProjectsDtoOf(
  runner: RunnerRecord,
  served: readonly ServedProjectRecord[],
): RunnerServedProjectDto[] {
  const declared = runner.capabilities.accessSources;
  return served
    .filter((project) => project.runnerId === runner.id)
    .map((project) => ({
      slug: project.slug,
      accessSource: project.accessSource,
      fit: declared === undefined || declared.includes(project.accessSource),
    }));
}

/**
 * Who reads a runner (#775): their user id, and the account owners' display names by user id. `userId` is NULL for a
 * door with no user row (the Access owner before the link, the local bypass): its shared audit name is no person, so
 * "enrolled by you" never matches it (#837).
 */
export interface RunnerReader {
  readonly userId: string | null;
  readonly ownerNames: ReadonlyMap<string, string>;
  /** The audit actor a scope write by this reader would record, which `setScope` compares with `enrolled_by`. */
  readonly actor: string;
  /** The account has at most one owner, so a runner from before `enrolled_by` counts as the reader's (#795). */
  readonly soleOwner: boolean;
}

async function runnerReaderOf(c: Context, account: AccountRecord): Promise<RunnerReader> {
  const identity = c.get('identity');
  const accounts = new AccountsRepo(c.env.DB);
  return {
    userId: identity.kind === 'user' ? identity.userId : null,
    ownerNames: await accounts.ownerDisplayNamesOf(account.id),
    actor: auditActorOf(identity).actor,
    soleOwner: (await accounts.ownerCountOf(account.id)) <= 1,
  };
}

/**
 * #825: whether the reader may add projects to the runner, by the terms of `setScope`'s guard (`scopeWriteAllowedSql`):
 * a hosted or Actions identity keeps its scope, an API-key-only runner is any owner's to widen, and a subscription
 * runner only its enroller's. Display only: the write judges it again on the stored row.
 */
function canWidenOf(runner: RunnerRecord, reader: RunnerReader): boolean {
  if (runner.revokedAt !== null || runner.hosted || runner.isolation === 'actions-ephemeral') {
    return false;
  }
  if (!runnerTakesSubscription(runner.capabilities)) {
    return true;
  }
  return runner.enrolledBy === null ? reader.soleOwner : runner.enrolledBy === reader.actor;
}

/**
 * #827: whether the console knows the runner's enroller, never who it is. `claimable` are the ids the caller may claim
 * now (`RunnersRepo.enrollerClaimableIdsOf`, the claim's own terms).
 */
function enrollerStateOf(runner: RunnerRecord, claimable: readonly string[]): RunnerEnrollerState {
  if (runner.revokedAt !== null || runner.hosted || runner.isolation === 'actions-ephemeral') {
    return 'not-applicable';
  }
  if (runner.enrolledBy !== null) {
    return 'recorded';
  }
  return claimable.includes(runner.id) ? 'claimable' : 'unrecorded';
}

/**
 * Who may claim a runner's enroller (#827, #837): a user by the id the sole-owner rule compares, the local bypass by
 * its door (`null`, the owner count alone). Everyone else is `unlinked` — above all the Access owner before the GitHub
 * link, who has no owner row, so beside one other owner's row the count alone would let them pass.
 */
type EnrollerClaimer = { readonly userId: string | null } | 'unlinked';

function enrollerClaimerOf(c: Context): EnrollerClaimer {
  const identity = c.get('identity');
  if (identity.kind === 'user') {
    return identity.userId === null ? 'unlinked' : { userId: identity.userId };
  }
  return identity.kind === 'local' ? { userId: null } : 'unlinked';
}

/** The runners the caller may claim now; none for an unlinked caller, whose claim the route refuses. */
async function claimableIdsOf(
  c: Context,
  runners: RunnersRepo,
  accountId: string,
): Promise<readonly string[]> {
  const claimer = enrollerClaimerOf(c);
  return claimer === 'unlinked' ? [] : runners.enrollerClaimableIdsOf(accountId, claimer.userId);
}

export function runnerDtoOf(
  runner: RunnerRecord,
  now: Date,
  minimumVersion: string | null,
  reader: RunnerReader,
  served: readonly ServedProjectRecord[] = [],
  claimable: readonly string[] = [],
  unattributed: ReadonlyMap<string, number> = new Map(),
): RunnerDto {
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
    projectScope: runner.projectScope,
    allowedProjects: runner.allowedProjects,
    servedProjects: servedProjectsDtoOf(runner, served),
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
    // A revoked runner claims nothing anyway; its last pause is history, not a state.
    pause: runner.revokedAt === null ? runnerPauseOf(runner, now) : null,
    // `enrolled_by` is the audit actor of the code's creator; compared with a real user id only, never sent (R-RUN).
    enrolledByYou: reader.userId !== null && runner.enrolledBy === reader.userId,
    // The enroller's display name only, and only while they own the account; their id never leaves (#804 condition 2).
    enrolledByName: runner.enrolledBy === null ? null : (reader.ownerNames.get(runner.enrolledBy) ?? null),
    enroller: enrollerStateOf(runner, claimable),
    canWiden: canWidenOf(runner, reader),
    unattributedProjects: unattributed.get(runner.id) ?? 0,
  };
}

function pendingEnrolmentDtoOf(enrolment: EnrolmentRecord): PendingEnrolmentDto {
  return {
    id: enrolment.codeHash,
    name: enrolment.name,
    projectScope: enrolment.projectScope,
    allowedProjects: enrolment.allowedProjects,
    createdAt: enrolment.createdAt,
    expiresAt: enrolment.expiresAt,
  };
}

/** The audit row of an owner's action on the account's runners: who acted comes from the identity, never a body. */
export function auditOf(
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

/** The runner as stored after a change, in the list's shape (served projects, enroller state). */
async function currentRunnerDtoOf(
  c: Context,
  runners: RunnersRepo,
  account: AccountRecord,
  before: RunnerRecord,
  now: Date,
): Promise<RunnerDto> {
  const updated = (await runners.findInAccount(account.id, before.id)) ?? before;
  return runnerDtoOf(
    updated,
    now,
    runnerReleaseOf(c.env).minimumVersion,
    await runnerReaderOf(c, account),
    await runners.servedProjectsOf(account.id, before.id),
    await claimableIdsOf(c, runners, account.id),
    await runners.unattributedProjectCountsOf(account.id, before.id),
  );
}

/**
 * `POST /api/v1/accounts/:id/runners/enrolment-code`, `GET …/runners`, `PATCH …/runners/:runner`,
 * `POST …/runners/:runner/revoke` (#467, ADR 0008 row 2-A): owner-of-account, as every account route. A runner of
 * another account is 404 `runner-not-found`, the same as one that does not exist; an allowed-projects list names
 * the account's own active projects only. Every change is an `audit_events` row in the change's batch.
 */
export function createAccountRunnerRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return (
    new Hono<WorkerHonoEnv<ApiEnv>>()
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
        const scope: RunnerProjectScopeDto = {
          projectScope: input.value.projectScope,
          allowedProjects: input.value.allowedProjects,
        };
        await new RunnersRepo(c.env.DB).createEnrolment(
          {
            codeHash: await sha256Hex(code),
            accountId: account.id,
            name: input.value.name,
            ...scope,
            createdBy: auditActorOf(c.get('identity')).actor,
            at,
            expiresAt,
          },
          auditOf(c, account, at, 'enrolment-code.created', 'enrolment-code', {
            name: input.value.name,
            ...scope,
            expiresAt,
          }),
        );
        c.get('logger').info('enrolment code created', {
          accountId: account.id,
          projectScope: scope.projectScope,
        });
        const body: EnrolmentCodeDto = {
          code,
          expiresAt,
          apiUrl: new URL(c.req.url).origin,
          audience: runnerAudienceOf(c.env.ENVIRONMENT),
          name: input.value.name,
          ...scope,
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
          policy:
            account.defaultRunnerPolicy === null
              ? null
              : effectivePolicyOf(account.defaultRunnerPolicy, null),
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
            return invalid(
              c,
              'runner-policy-invalid',
              'runner',
              'The policy must name unrevoked runners of this account',
            );
          }
        }
        const json = value === null ? null : JSON.stringify(value);
        const written = await new AccountsRepo(c.env.DB).setDefaultRunnerPolicy(
          account.id,
          json,
          auditOf(c, account, new Date().toISOString(), 'runner.policy-changed', account.id, {
            scope: 'account',
            policy: value,
          }),
        );
        // #687 (ADR 0009 d.3): a default that would reach a subscription project's hosted runner is refused in the write.
        if (written === 'access-source-hosted') {
          return accessSourceHosted(c);
        }
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
        // One read for every runner's effective projects (#775), the claim's own term.
        const served = await runners.servedProjectsOf(account.id);
        const claimable = await claimableIdsOf(c, runners, account.id);
        // #799: what D3 holds back for want of a recorded creator or enroller, counted per runner in one read.
        const unattributed = await runners.unattributedProjectCountsOf(account.id);
        const reader = await runnerReaderOf(c, account);
        const body: RunnerListDto = {
          // #668: an Actions identity is listed while its run is live; revoked, it is one finished job's history (in the
          // audit), not a machine the owner manages, so the list would otherwise grow by a row per run.
          runners: (await runners.listForAccount(account.id))
            .filter((runner) => runner.isolation !== 'actions-ephemeral' || runner.revokedAt === null)
            .map((runner) =>
              runnerDtoOf(runner, now, release.minimumVersion, reader, served, claimable, unattributed),
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
          return problem(c, {
            type: 'runner-revoked',
            title: 'Conflict',
            status: 409,
            detail: 'The runner is revoked',
          });
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
          return problem(c, {
            type: 'runner-not-suspect',
            title: 'Conflict',
            status: 409,
            detail: 'The runner is not marked suspect',
          });
        }
        return c.json(await currentRunnerDtoOf(c, runners, account, runner, now));
      })

      // #775: the runner's scope — every project of the account, present and future, or a list — changeable without
      // re-enrolling: the claim and every job-token write read the stored row, and the runner takes the scope from each
      // claim and `GET /runner/self`.
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
        // R-SCOPE-4 (C12 row 6): a hosted or Actions identity serves exactly what the server gave it; its scope is not
        // the owner's to widen, nor to touch at all.
        if (runner.hosted || runner.isolation === 'actions-ephemeral') {
          return invalid(
            c,
            'runner-scope-fixed',
            'projectScope',
            'A hosted or GitHub Actions runner keeps the scope the console gave it',
          );
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
        const before: RunnerProjectScopeDto = {
          projectScope: runner.projectScope,
          allowedProjects: runner.allowedProjects,
        };
        // The runner's live jobs in projects the new scope no longer serves are cancelled in the same batch (#490 review,
        // R-SCOPE-5, #794) — judged by the claim's own term, so `selected`→`all` under D3 cancels what it drops too. A
        // no-op writes, audits and cancels nothing.
        const written = await runners.setScope(
          account.id,
          runner.id,
          input.value,
          auditActorOf(c.get('identity')).actor,
          auditOf(c, account, now.toISOString(), 'runner.scope-changed', runner.id, {
            from: before,
            to: input.value,
          }),
          new JobsRepo(c.env.DB).cancelUnservedStatements(runner.id, now.toISOString()),
        );
        // #795: a subscription runner is the enrolling owner's to widen; another owner may only narrow it.
        if (written === 'enroller-only') {
          c.get('logger').warn('runner scope refused', {
            reason: 'runner-scope-enroller-only',
            runnerId: runner.id,
          });
          return problem(c, {
            type: 'runner-scope-enroller-only',
            title: 'Forbidden',
            status: 403,
            detail:
              'Only the owner who enrolled this runner can add projects to it: its sign-in may be their subscription',
          });
        }
        return c.json(await currentRunnerDtoOf(c, runners, account, runner, now));
      })

      // #827 (owner decision (a)): a runner from before `enrolled_by` is nobody's to widen once a second owner joins
      // (D3, #795). While the account has one owner, that owner records themselves as its enroller, audited.
      .post('/:id/runners/:runner/claim-enroller', async (c) => {
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
        const claimer = enrollerClaimerOf(c);
        if (claimer === 'unlinked') {
          c.get('logger').warn('runner enroller claim refused', {
            reason: 'runner-enroller-unlinked',
            runnerId: runner.id,
          });
          return problem(c, {
            type: 'runner-enroller-unlinked',
            title: 'Forbidden',
            status: 403,
            detail: 'Link your GitHub account to the console before you claim a runner as yours',
          });
        }
        const now = new Date();
        // Every other rule is judged inside the write; the outcome only picks the answer.
        const claim = await runners.claimEnroller(
          account.id,
          runner.id,
          auditActorOf(c.get('identity')).actor,
          claimer.userId,
          auditOf(c, account, now.toISOString(), 'runner.enroller-claimed', runner.id, {
            basis: 'sole-owner',
          }),
        );
        switch (claim) {
          case 'claimed':
            c.get('logger').info('runner enroller claimed', { runnerId: runner.id });
            return c.json(await currentRunnerDtoOf(c, runners, account, runner, now));
          case 'not-found':
            return runnerNotFound(c);
          case 'already-set':
            return problem(c, {
              type: 'runner-enroller-set',
              title: 'Conflict',
              status: 409,
              detail: 'The console already knows who enrolled this runner',
            });
          case 'revoked':
            return problem(c, {
              type: 'runner-revoked',
              title: 'Conflict',
              status: 409,
              detail: 'The runner is revoked',
            });
          case 'fixed':
            return invalid(
              c,
              'runner-enroller-fixed',
              'runner',
              'A hosted or GitHub Actions runner has no enroller to claim',
            );
          case 'not-sole-owner':
            c.get('logger').warn('runner enroller claim refused', {
              reason: 'runner-enroller-not-sole-owner',
              runnerId: runner.id,
            });
            return problem(c, {
              type: 'runner-enroller-not-sole-owner',
              title: 'Forbidden',
              status: 403,
              detail: 'Only the sole owner of the account can claim a runner as theirs; re-enrol it instead',
            });
        }
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
        // ADR 0006: revoking a runner cancels the jobs it holds, in the same batch (their tokens die with it); #1059:
        // its live check fails as `runner-revoked`, audited, in that batch too.
        const revoked = await runners.revoke(
          account.id,
          runner.id,
          at,
          auditOf(c, account, at, 'runner.revoked', runner.id, { name: runner.name }),
          [
            ...new JobsRepo(c.env.DB).cancelForRunnerStatements(runner.id, at),
            ...(await new RunnerChecksRepo(c.env.DB).failLiveOnRevokeStatements(account.id, runner.id, at)),
          ],
        );
        if (!revoked) {
          return problem(c, { type: 'runner-revoked', title: 'Conflict', status: 409 });
        }
        c.get('logger').info('runner revoked', { runnerId: runner.id });
        const updated = await runners.findInAccount(account.id, runner.id);
        // A revoked runner serves nothing; `servedProjectsOf` lists none for it.
        return c.json(
          runnerDtoOf(
            updated ?? runner,
            now,
            runnerReleaseOf(c.env).minimumVersion,
            await runnerReaderOf(c, account),
          ),
        );
      })
  );
}
