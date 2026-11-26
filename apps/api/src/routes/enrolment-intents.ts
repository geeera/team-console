import { Hono } from 'hono';
import {
  ENROLMENT_ACCOUNT_NAME_MAX,
  ENROLMENT_INTENTS_LIVE_MAX,
  ENROLMENT_INTENTS_PER_HOUR,
  ENROLMENT_INTENT_COLLECT_SECONDS,
  ENROLMENT_INTENT_POLL_SECONDS,
  ENROLMENT_INTENT_TTL_SECONDS,
  RUNNER_POLL_SECONDS,
  checkApproveEnrolmentIntentInput,
  checkCreateEnrolmentIntentInput,
  checkPollEnrolmentInput,
  checkStartEnrolmentInput,
  isEnrolmentIntentId,
  runnerAudienceOf,
  runnerKeyFingerprintOf,
  setupCommandOf,
  shownTextOf,
  type EnrolRunnerResponse,
  type EnrolmentIntentCreatedDto,
  type EnrolmentIntentDto,
  type EnrolmentIntentListDto,
  type EnrolmentIntentState,
  type PollEnrolmentPendingDto,
  type StartEnrolmentResponse,
} from '@shared/contracts';
import { ENROLMENT_POLL_TOKEN_PREFIX, OPAQUE_TOKEN_TAIL } from '@shared/redaction';
import {
  newUlid,
  problem,
  randomOpaqueToken,
  sha256Hex,
  timingSafeEqualText,
  type ProblemExtensionValue,
  type WorkerContext,
  type WorkerHonoEnv,
} from '@worker/core';
import {
  AccountsRepo,
  EnrolmentIntentsRepo,
  RunnersRepo,
  type AccountRecord,
  type EnrolmentIntentRecord,
  type IntentOwner,
} from '@worker/db';
import { DoorRateLimits, type DoorLimitScope } from '../auth/door-rate-limits';
import { auditActorOf } from '../auth/scope';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../tracker/http';
import { auditOf, foreignSlugsOf } from './account-runners';
import { ownedAccountOf } from './accounts';
import { linuxInstallCommandsOf, macInstallCommandsOf } from './runner-install-command';
import {
  ENROL_RATE_LIMIT_GLOBAL_PER_MINUTE,
  ENROL_RATE_LIMIT_PER_MINUTE,
  ENROL_RATE_LIMIT_UNVERIFIED_PER_MINUTE,
  isolationNoneRefusal,
} from './runner';

type Context = WorkerContext<ApiEnv>;

/**
 * Polls per source address per minute, in a bucket of its own beside the door's ten a minute: one runner polls
 * twelve times a minute, and a few machines may enrol from behind one address at once.
 */
export const ENROL_POLL_RATE_LIMIT_PER_MINUTE = 60;
/** A poll sooner than this after the binder's last one is `slow-down`: the interval less a second of jitter. */
const POLL_MIN_GAP_SECONDS = ENROLMENT_INTENT_POLL_SECONDS - 1;
const POLL_TOKEN = new RegExp(`^${ENROLMENT_POLL_TOKEN_PREFIX}${OPAQUE_TOKEN_TAIL}$`);

function invalid(c: Context, type: string, field: string, detail: string): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, { type, title: 'Invalid request', status: 422, detail, extensions });
}

/**
 * One answer for an intent that is unknown, expired or withdrawn, on the runner's door and the owner's alike: on the
 * door nothing about intents is enumerable (R-INT-5), and to the owner another account's or another owner's intent
 * is the same as none (R-INT-2).
 */
function intentNotFound(c: Context): Response {
  return problem(c, { type: 'enrolment-not-found', title: 'Enrolment request not found', status: 404 });
}

/**
 * 410 `enrolment-gone` (#817): only to the binder, once its poll token proved it, for an intent that will never enrol
 * it — withdrawn, expired, past its collection window, or its runner revoked. The binder already knows the intent,
 * so telling it apart from an unknown one leaks nothing, and the runner can stop for good instead of guessing.
 */
function intentGone(c: Context, reason: string): Response {
  c.get('logger').warn('enrolment refused', { reason });
  return problem(c, { type: 'enrolment-gone', title: 'Enrolment request gone', status: 410 });
}

/**
 * 503 `console-origin-misconfigured` (#817): this console has no origin a pasted command may name, so it makes no
 * intent at all — one without a command could only hold an open slot until it expired.
 */
function commandOriginMissing(c: Context): Response {
  c.get('logger').error('enrolment intent refused', { reason: 'console-origin-misconfigured' });
  return problem(c, {
    type: 'console-origin-misconfigured',
    title: 'The console cannot build the setup command',
    status: 503,
    detail: 'CONSOLE_PUBLIC_ORIGIN of this console is missing or not safe to put in a command',
  });
}

function conflict(c: Context, type: string, detail: string): Response {
  return problem(c, { type, title: 'Conflict', status: 409, detail });
}

function accountSuspended(c: Context): Response {
  c.get('logger').warn('enrolment refused', { reason: 'account-suspended' });
  return problem(c, { type: 'account-suspended', title: 'Forbidden', status: 403 });
}

/** What the owner sees: a pending or bound intent past its time is `expired`, whatever the row still says. */
export function intentStateAt(
  intent: Pick<EnrolmentIntentRecord, 'state' | 'expiresAt'>,
  now: string,
): EnrolmentIntentState {
  return (intent.state === 'pending' || intent.state === 'bound') && intent.expiresAt <= now
    ? 'expired'
    : intent.state;
}

function intentDtoOf(intent: EnrolmentIntentRecord, now: string): EnrolmentIntentDto {
  return {
    id: intent.id,
    state: intentStateAt(intent, now),
    name: intent.name,
    projectScope: intent.projectScope,
    allowedProjects: intent.allowedProjects,
    isolation: intent.isolation,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    host: intent.bind?.host ?? null,
    version: intent.bind?.version ?? null,
    fingerprint: intent.bind?.fingerprint ?? null,
    boundAt: intent.bind?.at ?? null,
    boundCountry: intent.bind?.country ?? null,
    runnerId: intent.runnerId,
  };
}

/**
 * The origin the copied command names: the configured `CONSOLE_PUBLIC_ORIGIN`, never the request's `Host` (R-ONE-1).
 * `local` alone answers with the request's own origin: the local stack runs with another environment's vars, and
 * nothing it serves is deployed.
 */
function commandOriginOf(c: Context): string | null {
  if (c.env.ENVIRONMENT === 'local') {
    return new URL(c.req.url).origin;
  }
  const configured = c.env.CONSOLE_PUBLIC_ORIGIN ?? '';
  return configured === '' ? null : configured;
}

/** The caller as an intent's owner: the account of the route and the audit actor the intent must have been made by. */
function intentOwnerOf(c: Context, account: AccountRecord): IntentOwner {
  return { accountId: account.id, createdBy: auditActorOf(c.get('identity')).actor };
}

/**
 * `POST /api/v1/accounts/:id/runners/enrolment-intents`, `GET …/enrolment-intents` (the caller's open ones, #817),
 * `GET …/enrolment-intents/:intent`, `POST …/:intent/approve` and `POST …/:intent/withdraw` (#634 PR 3, architect
 * note section 2): owner-of-account, CSRF-protected as every
 * cookie-borne write, and narrower than the account — an intent answers only to the owner who made it (R-INT-2), so
 * there is no approve page a stranger's link could lead to. The approval creates the runner from the intent row alone
 * (R-INT-6) after comparing the fingerprint the wizard displayed with the bound key (compare-and-set).
 */
export function createAccountEnrolmentIntentRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return (
    new Hono<WorkerHonoEnv<ApiEnv>>()
      .post('/:id/runners/enrolment-intents', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
        const account = await ownedAccountOf(c);
        if (account instanceof Response) {
          return account;
        }
        const input = checkCreateEnrolmentIntentInput(await jsonBody(c));
        if (!input.ok) {
          return invalid(c, 'enrolment-intent-invalid', input.field, input.detail);
        }
        const { name, isolation, projectScope, allowedProjects } = input.value;
        const isolationRefusal = isolationNoneRefusal(c, isolation);
        if (isolationRefusal !== null) {
          return isolationRefusal;
        }
        if ((await foreignSlugsOf(c, account, allowedProjects)).length > 0) {
          return invalid(
            c,
            'allowed-projects-invalid',
            'allowedProjects',
            'allowedProjects must name active projects of this account',
          );
        }
        const now = new Date();
        const at = now.toISOString();
        const expiresAt = new Date(now.getTime() + ENROLMENT_INTENT_TTL_SECONDS * 1000).toISOString();
        const intentId = newUlid(now.getTime());
        // Judged before the write: the command names only the origin and this id, so it is known now.
        const origin = commandOriginOf(c);
        const command = origin === null ? null : setupCommandOf(origin, intentId);
        if (origin === null || command === null) {
          return commandOriginMissing(c);
        }
        const outcome = await new EnrolmentIntentsRepo(c.env.DB).create(
          {
            id: intentId,
            ...intentOwnerOf(c, account),
            name,
            projectScope,
            allowedProjects,
            isolation,
            at,
            expiresAt,
          },
          { liveMax: ENROLMENT_INTENTS_LIVE_MAX, perHour: ENROLMENT_INTENTS_PER_HOUR },
          auditOf(c, account, at, 'enrolment-intent.created', intentId, {
            name,
            projectScope,
            allowedProjects,
            isolation,
            expiresAt,
          }),
        );
        if (outcome === 'live-limit') {
          return conflict(
            c,
            'enrolment-intent-limit',
            `An account holds at most ${String(ENROLMENT_INTENTS_LIVE_MAX)} open enrolment requests: withdraw one or wait for it to expire`,
          );
        }
        if (outcome === 'hourly-limit') {
          c.get('logger').warn('enrolment intent refused', { reason: 'hourly-limit', accountId: account.id });
          return problem(c, { type: 'rate-limited', title: 'Too Many Requests', status: 429 });
        }
        c.get('logger').info('enrolment intent created', { accountId: account.id, projectScope, isolation });
        const body: EnrolmentIntentCreatedDto = {
          intentId,
          expiresAt,
          command,
          installCommands: isolation === 'user' ? macInstallCommandsOf(c.env, origin, intentId) : null,
          linuxInstall: isolation === 'container' ? linuxInstallCommandsOf(c.env, origin, intentId) : null,
        };
        return c.json(body, 201);
      })

      // #817: the caller's own open intents, so one held by a closed tab can be withdrawn before it expires.
      .get('/:id/runners/enrolment-intents', async (c) => {
        const account = await ownedAccountOf(c);
        if (account instanceof Response) {
          return account;
        }
        const now = new Date().toISOString();
        const intents = await new EnrolmentIntentsRepo(c.env.DB).listOpen(
          intentOwnerOf(c, account),
          now,
          ENROLMENT_INTENTS_LIVE_MAX,
        );
        const body: EnrolmentIntentListDto = { intents: intents.map((intent) => intentDtoOf(intent, now)) };
        return c.json(body);
      })

      .get('/:id/runners/enrolment-intents/:intent', async (c) => {
        const account = await ownedAccountOf(c);
        if (account instanceof Response) {
          return account;
        }
        const intentId = c.req.param('intent');
        const intent = isEnrolmentIntentId(intentId)
          ? await new EnrolmentIntentsRepo(c.env.DB).findOwned(intentOwnerOf(c, account), intentId)
          : null;
        return intent === null ? intentNotFound(c) : c.json(intentDtoOf(intent, new Date().toISOString()));
      })

      .post(
        '/:id/runners/enrolment-intents/:intent/approve',
        writeLimit(SMALL_WRITE_MAX_BYTES),
        async (c) => {
          const account = await ownedAccountOf(c);
          if (account instanceof Response) {
            return account;
          }
          const intentId = c.req.param('intent');
          const owner = intentOwnerOf(c, account);
          const intents = new EnrolmentIntentsRepo(c.env.DB);
          const found = isEnrolmentIntentId(intentId) ? await intents.findOwned(owner, intentId) : null;
          if (found === null) {
            return intentNotFound(c);
          }
          const input = checkApproveEnrolmentIntentInput(await jsonBody(c));
          if (!input.ok) {
            return invalid(c, 'enrolment-intent-invalid', input.field, input.detail);
          }
          const { fingerprint } = input.value;
          const now = new Date();
          const at = now.toISOString();

          // The answer for an intent the approval cannot (or need not) write, from the row as it stands now.
          const settled = (intent: EnrolmentIntentRecord): Response => {
            const state = intentStateAt(intent, at);
            if (state === 'expired' || state === 'withdrawn') {
              return intentNotFound(c);
            }
            if (state === 'pending') {
              return conflict(c, 'enrolment-intent-not-bound', 'No runner has asked on this request yet');
            }
            // R-INT-1: the owner approves the key they were shown, never one bound since.
            if (intent.bind?.fingerprint !== fingerprint) {
              c.get('logger').warn('enrolment refused', { reason: 'fingerprint-mismatch' });
              return conflict(
                c,
                'enrolment-fingerprint-mismatch',
                'The fingerprint is not the one of the runner that asked',
              );
            }
            // Approved already with this very key (a repeated click): the same answer, nothing written again.
            return state === 'bound'
              ? conflict(
                  c,
                  'enrolment-intent-changed',
                  'The request changed while it was being approved: read it again',
                )
              : c.json(intentDtoOf(intent, at));
          };

          if (intentStateAt(found, at) !== 'bound' || found.bind?.fingerprint !== fingerprint) {
            return settled(found);
          }
          const isolationRefusal = isolationNoneRefusal(c, found.isolation);
          if (isolationRefusal !== null) {
            return isolationRefusal;
          }
          if (account.suspendedAt !== null) {
            return accountSuspended(c);
          }
          const runnerId = newUlid(now.getTime());
          const approved = await intents.approve(
            owner,
            found.id,
            { fingerprint, runnerId, at },
            (intent, bind) =>
              auditOf(c, account, at, 'runner.enrolled', runnerId, {
                name: intent.name,
                isolation: intent.isolation,
                version: bind.version,
                projectScope: intent.projectScope,
                allowedProjects: intent.allowedProjects,
                accessSources: bind.capabilities.accessSources ?? null,
                createdBy: intent.createdBy,
                via: 'intent',
                intentId: intent.id,
                fingerprint: bind.fingerprint,
              }),
          );
          if (approved === null) {
            // The write decided (a withdrawal, an expiry or a second approval won since the read above); read again to say which.
            const current = await intents.findOwned(owner, found.id);
            return current === null ? intentNotFound(c) : settled(current);
          }
          c.get('logger').info('runner enrolled', { runnerId, isolation: approved.isolation, via: 'intent' });
          return c.json(intentDtoOf(approved, at));
        },
      )

      .post('/:id/runners/enrolment-intents/:intent/withdraw', async (c) => {
        const account = await ownedAccountOf(c);
        if (account instanceof Response) {
          return account;
        }
        const intentId = c.req.param('intent');
        const at = new Date().toISOString();
        // One 404 for a malformed id, another account's or another owner's intent, an expired, an approved or an
        // already withdrawn one.
        const withdrawn =
          isEnrolmentIntentId(intentId) &&
          (await new EnrolmentIntentsRepo(c.env.DB).withdraw(
            intentOwnerOf(c, account),
            intentId,
            at,
            auditOf(c, account, at, 'enrolment-intent.withdrawn', intentId, {}),
          ));
        if (!withdrawn) {
          return intentNotFound(c);
        }
        c.get('logger').info('enrolment intent withdrawn', { accountId: account.id });
        return c.body(null, 204);
      })
  );
}

/**
 * `POST /api/v1/runner/enrol/start` and `POST /api/v1/runner/enrol/poll` (#634 PR 3): the runner's side of an intent,
 * with no identity yet. `start` binds the runner's public key to a pending intent — first bind wins, a second is 409
 * `enrolment-intent-bound` — and returns the poll token once (256 random bits; D1 holds its hash). `poll` answers 202
 * until the owner approved, then the enrolment on every poll of the collection window (#817). The request carries a
 * key, host, capabilities, backend and version and nothing else: no account, name or scope (the intent row's alone,
 * R-INT-6) and no credential of any kind. To anyone without the poll token an unknown, expired or withdrawn intent is
 * one 404 with one body on both calls; the token's holder learns 410 `enrolment-gone` instead (#817). Counted in the door's own
 * buckets (`DoorRateLimits('enrol')`): per address, junk for the environment, verified for the environment.
 */
export function createRunnerEnrolmentIntentRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/enrol/start', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const logger = c.get('logger');
      const now = new Date();
      const at = now.toISOString();
      const limits = new DoorRateLimits(c.env.DB, 'enrol', now.getTime());
      const rateLimited = (scope: DoorLimitScope): Response => {
        logger.warn('enrolment refused', { reason: 'rate-limited', scope });
        return problem(c, {
          type: 'rate-limited',
          title: 'Too Many Requests',
          status: 429,
          retryAfter: limits.retryAfter(),
        });
      };
      if (!(await limits.hitAddress(c.req.header('CF-Connecting-IP'), ENROL_RATE_LIMIT_PER_MINUTE, logger))) {
        return rateLimited('ip');
      }
      // Every refusal before a pending intent is junk; once the junk bucket is over, all of it answers 429 alike.
      const junk = async (reason: string, refusal: () => Response): Promise<Response> => {
        logger.warn('enrolment refused', { reason });
        return (await limits.hitUnverified(ENROL_RATE_LIMIT_UNVERIFIED_PER_MINUTE))
          ? refusal()
          : rateLimited('unverified');
      };

      const input = checkStartEnrolmentInput(await jsonBody(c));
      if (!input.ok) {
        return junk('start-malformed', () => invalid(c, 'enrol-invalid', input.field, input.detail));
      }
      const { value } = input;
      const intents = new EnrolmentIntentsRepo(c.env.DB);
      // The refusal an intent in this state earns, or `null` for one a runner may still bind.
      const stateRefusalOf = (current: EnrolmentIntentRecord): (() => Promise<Response>) | null => {
        const state = intentStateAt(current, at);
        if (state === 'expired' || state === 'withdrawn') {
          return () => junk(`intent-${state}`, () => intentNotFound(c));
        }
        if (state !== 'pending') {
          // R-INT-1: the real `setup` learns that another machine holds its request, and says so.
          return () =>
            junk('intent-bound', () =>
              conflict(
                c,
                'enrolment-intent-bound',
                'Another machine already asked on this request: reject it in the console',
              ),
            );
        }
        return null;
      };
      const intent = await intents.findById(value.intentId);
      if (intent === null) {
        return junk('intent-unknown', () => intentNotFound(c));
      }
      const refusal = stateRefusalOf(intent);
      if (refusal !== null) {
        return refusal();
      }
      if (!(await limits.hitVerified(ENROL_RATE_LIMIT_GLOBAL_PER_MINUTE))) {
        return rateLimited('verified');
      }
      const account = await new AccountsRepo(c.env.DB).findById(intent.accountId);
      if (account === null || account.suspendedAt !== null) {
        return accountSuspended(c);
      }
      const isolationRefusal = isolationNoneRefusal(c, intent.isolation);
      if (isolationRefusal !== null) {
        return isolationRefusal;
      }
      // R-INT-6: the backend is the owner's choice; a runner set up for another one does not bind.
      if (value.isolation !== intent.isolation) {
        logger.warn('enrolment refused', { reason: 'isolation-mismatch' });
        return invalid(
          c,
          'enrolment-isolation-mismatch',
          'isolation',
          'This request was made for another isolation backend',
        );
      }

      const pollToken = randomOpaqueToken(ENROLMENT_POLL_TOKEN_PREFIX);
      const fingerprint = await runnerKeyFingerprintOf(value.publicKey);
      const country = c.req.header('CF-IPCountry') ?? null;
      const actor = auditActorOf(c.get('identity'));
      const bound = await intents.bind(
        intent.id,
        value.isolation,
        {
          publicKeyX: value.publicKey.x,
          host: value.host,
          capabilities: value.capabilities,
          version: value.version,
          fingerprint,
          pollTokenHash: await sha256Hex(pollToken),
          at,
          country,
        },
        {
          accountId: intent.accountId,
          at,
          actorKind: actor.kind,
          actor: actor.actor,
          kind: 'enrolment-intent.bound',
          target: intent.id,
          details: { fingerprint, isolation: value.isolation, version: value.version },
          ipCountry: country,
        },
      );
      if (!bound) {
        // Another `start` won the bind, or the owner withdrew, since the read above: the row says which.
        const current = await intents.findById(intent.id);
        const lost = current === null ? null : stateRefusalOf(current);
        // Still pending and unbound: the only condition left in the write is the account's suspension.
        return lost === null ? accountSuspended(c) : lost();
      }
      logger.info('enrolment intent bound', { accountId: intent.accountId, isolation: value.isolation });
      const body: StartEnrolmentResponse = {
        pollToken,
        fingerprint,
        intervalSeconds: ENROLMENT_INTENT_POLL_SECONDS,
        expiresAt: intent.expiresAt,
        // Untrusted text at the runner (R-INT-3), which refuses control and bidi characters: never send one. The
        // slug is the account's own safe name when nothing visible is left.
        accountName: shownTextOf(account.name, ENROLMENT_ACCOUNT_NAME_MAX) || account.slug,
      };
      return c.json(body);
    })

    .post('/enrol/poll', writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const logger = c.get('logger');
      const now = new Date();
      const at = now.toISOString();
      const limits = new DoorRateLimits(c.env.DB, 'enrol', now.getTime());
      const rateLimited = (scope: DoorLimitScope): Response => {
        logger.warn('enrolment refused', { reason: 'rate-limited', scope });
        return problem(c, {
          type: 'rate-limited',
          title: 'Too Many Requests',
          status: 429,
          retryAfter: limits.retryAfter(),
        });
      };
      if (
        !(await limits.hitAddress(
          c.req.header('CF-Connecting-IP'),
          ENROL_POLL_RATE_LIMIT_PER_MINUTE,
          logger,
          'poll-ip',
        ))
      ) {
        return rateLimited('ip');
      }
      const junk = async (reason: string, refusal: () => Response): Promise<Response> => {
        logger.warn('enrolment refused', { reason });
        return (await limits.hitUnverified(ENROL_RATE_LIMIT_UNVERIFIED_PER_MINUTE))
          ? refusal()
          : rateLimited('unverified');
      };

      const input = checkPollEnrolmentInput(await jsonBody(c));
      if (!input.ok) {
        return junk('poll-malformed', () => invalid(c, 'enrol-invalid', input.field, input.detail));
      }
      const { intentId, pollToken } = input.value;
      const intents = new EnrolmentIntentsRepo(c.env.DB);
      const intent = await intents.findById(intentId);
      const tokenHash = await sha256Hex(pollToken);
      // The equality decides; the constant-time compare keeps the answer's timing flat for a guessed token.
      if (
        !POLL_TOKEN.test(pollToken) ||
        intent === null ||
        intent.bind === null ||
        !timingSafeEqualText(intent.bind.pollTokenHash, tokenHash)
      ) {
        return junk('poll-token-unknown', () => intentNotFound(c));
      }
      // From here the caller is the binder: an intent that will never enrol it is 410, not the stranger's 404 (#817).
      const state = intentStateAt(intent, at);
      if (state === 'expired' || state === 'withdrawn') {
        return intentGone(c, `intent-${state}`);
      }
      if (!(await intents.admitPoll(intent.id, tokenHash, at, POLL_MIN_GAP_SECONDS))) {
        logger.warn('enrolment refused', { reason: 'slow-down' });
        return problem(c, {
          type: 'slow-down',
          title: 'Too Many Requests',
          status: 429,
          retryAfter: ENROLMENT_INTENT_POLL_SECONDS,
        });
      }
      if (state === 'bound') {
        const pending: PollEnrolmentPendingDto = {
          state: 'bound',
          intervalSeconds: ENROLMENT_INTENT_POLL_SECONDS,
        };
        return c.json(pending, 202);
      }
      // Approved or already collected: every poll in the window gets the same runner (#817), so an answer lost on the
      // way is not the enrolment lost.
      const runnerId = await intents.collect(intent.id, tokenHash, at, ENROLMENT_INTENT_COLLECT_SECONDS);
      const runner = runnerId === null ? null : await new RunnersRepo(c.env.DB).findById(runnerId);
      // Past the collection window, or revoked by the owner since the approval.
      if (runner === null || runner.revokedAt !== null) {
        return intentGone(c, 'intent-not-collectable');
      }
      logger.info('enrolment collected', { runnerId: runner.id });
      // The same answer `/enrol` gives, from the runner row the approval wrote: no secret in it.
      const body: EnrolRunnerResponse = {
        runnerId: runner.id,
        accountId: runner.accountId,
        name: runner.name,
        audience: runnerAudienceOf(c.env.ENVIRONMENT),
        projectScope: runner.projectScope,
        allowedProjects: runner.allowedProjects,
        pollSeconds: RUNNER_POLL_SECONDS,
      };
      return c.json(body);
    });
}
