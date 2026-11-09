import { Hono } from 'hono';
import { problem, type Logger, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  InstallationsRepo,
  OwnWritesRepo,
  OwnerRequestsRepo,
  ProjectsRepo,
  PullRequestsRepo,
  WebhookDeliveriesRepo,
  isSnoozedAt,
  type ProjectRow,
} from '@worker/db';
import { handledRequestOf } from '@worker/read-models';
import { githubWebhooks } from '@worker/vcs-github';
import type { HooksEnv } from '../env';
import { WEBHOOK_BODY_MAX_BYTES, readBodyCapped } from '../github/body';
import {
  commentOf,
  envelopeOf,
  isJsonObject,
  issueOf,
  pushRefOf,
  repositoriesOf,
  type Envelope,
  type JsonObject,
} from '../github/payload';
import { sha256Hex, webhookSecretsOf } from '../github/signature';
import type { PushLanguage, PushNotification } from '@worker/push';
import { linkNotificationOf, mapEvent, settingsLinkOf, type MappedProject } from '../mapping/map-event';
import { applySnooze } from '../mapping/snooze';
import type { NotificationSenderFactory } from '../push/push-sender';

/** The answer GitHub gets; only its status code matters to GitHub, the body is for the delivery log. */
export interface WebhookAck {
  readonly status: 'pong' | 'duplicate' | 'ignored' | 'queued' | 'updated' | 'request-handled';
  readonly reason?: IgnoredReason;
}

export type IgnoredReason =
  | 'unhandled-event'
  | 'unregistered'
  | 'installation-mismatch'
  | 'own-write'
  | 'untrusted-author'
  | 'no-notification'
  | 'snoozed';

export interface GitHubWebhookDeps {
  /** Builds the push sender per request (bindings differ per environment); see `webPushSenders`. */
  readonly senders: NotificationSenderFactory;
  /** A seam for the pruning cut-off in tests. */
  readonly now?: () => Date;
}

/** Deliveries are kept a week for dedupe and Settings' "last event" (#83), then pruned. */
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Inline pruning on every n-th delivery (by row id) until a cron exists. */
export const PRUNE_EVERY = 100;

/** What the app subscribes to (ADR 0003 decision 5), plus the installation events GitHub always sends. */
const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'workflow_run',
  'release',
  'push',
  'installation',
  'installation_repositories',
]);
/** Events that change what the api Worker's read models show; `push` only to the default branch. */
const EPOCH_EVENTS: ReadonlySet<string> = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'workflow_run',
  'release',
]);

// GitHub's delivery ids are GUIDs and event names snake_case; anything else is not GitHub talking.
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

/** No owner language reaches this Worker yet (it reads no `project.yml`), so pushes use the reference copy. */
const DEFAULT_LANGUAGE: PushLanguage = 'ru';

interface Outcome {
  readonly httpStatus: 200 | 202;
  readonly ack: WebhookAck;
  readonly messages: readonly PushNotification[];
}

const ignored = (reason: IgnoredReason): Outcome => ({
  httpStatus: 200,
  ack: { status: 'ignored', reason },
  messages: [],
});

function mappedProjectOf(row: ProjectRow): MappedProject {
  return { slug: row.slug, displayName: row.display_name, language: DEFAULT_LANGUAGE };
}

function statusLabelOf(ack: WebhookAck): string {
  return ack.reason === undefined ? ack.status : `${ack.status}:${ack.reason}`;
}

function parseJsonObject(bytes: ArrayBuffer): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return isJsonObject(parsed) ? parsed : null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

async function fanOut(
  senders: NotificationSenderFactory,
  env: HooksEnv,
  messages: readonly PushNotification[],
  deliveryId: string,
  logger: Logger,
): Promise<void> {
  const sender = senders(env, logger);
  if (sender === null) {
    logger.info('webhook fan-out', { sent: 0, pruned: 0, failed: messages.length, deliveryId });
    return;
  }
  let sent = 0;
  let pruned = 0;
  let failed = 0;
  for (const message of messages) {
    try {
      const result = await sender.sendToAll(message);
      sent += result.sent;
      pruned += result.pruned;
      failed += result.failed;
    } catch (error: unknown) {
      // Only the error's name: a push endpoint in a message is a capability URL.
      failed += 1;
      logger.error('push fan-out failed', {
        deliveryId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  logger.info('webhook fan-out', { sent, pruned, failed, deliveryId });
}

async function pruneDeliveries(deliveries: WebhookDeliveriesRepo, now: Date, logger: Logger): Promise<void> {
  try {
    const removed = await deliveries.pruneBefore(
      new Date(now.getTime() - DELIVERY_RETENTION_MS).toISOString(),
    );
    logger.info('webhook deliveries pruned', { removed });
  } catch (error: unknown) {
    logger.warn('webhook delivery pruning failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * The account a delivery's installation is linked to (ADR 0008 decision 2, threat model C9): the signature says
 * "one of our app's installations", the link says whose. An unlinked installation reaches no project.
 */
async function linkedAccountOf(db: D1Database, installationId: number | null): Promise<string | null> {
  if (installationId === null) {
    return null;
  }
  const link = await new InstallationsRepo(db).findLinked('github', String(installationId));
  return link === null || link.suspendedAt !== null ? null : link.accountId;
}

/**
 * `installation_repositories` and `installation`: keep `projects.access_lost_at` in step (ADR 0003 decision 5),
 * for the projects of the account the installation is linked to and no other.
 */
async function handleInstallation(
  db: D1Database,
  event: string,
  envelope: Envelope,
  payload: JsonObject,
  receivedAt: string,
): Promise<Outcome> {
  const installationId = envelope.installationId;
  const accountId = await linkedAccountOf(db, installationId);
  if (installationId === null || accountId === null) {
    return ignored('installation-mismatch');
  }
  const projects = new ProjectsRepo(db);
  let lost: ProjectRow[] = [];
  if (event === 'installation_repositories' && envelope.action === 'removed') {
    for (const repo of repositoriesOf(payload, 'repositories_removed')) {
      lost.push(...(await projects.markAccessLost(repo, installationId, accountId, receivedAt)));
    }
  } else if (event === 'installation_repositories' && envelope.action === 'added') {
    let restored = 0;
    for (const repo of repositoriesOf(payload, 'repositories_added')) {
      restored += (await projects.clearAccessLost(repo, installationId, accountId)).length;
    }
    return restored === 0
      ? ignored('unregistered')
      : { httpStatus: 200, ack: { status: 'updated' }, messages: [] };
  } else if (event === 'installation' && envelope.action === 'deleted') {
    lost = await projects.markInstallationLost(installationId, accountId, receivedAt);
  } else {
    return ignored('no-notification');
  }
  if (lost.length === 0) {
    return ignored('unregistered');
  }
  const messages = lost.map((row) =>
    linkNotificationOf(mappedProjectOf(row), 'access-lost', settingsLinkOf(row.slug), { repo: row.repo }),
  );
  return { httpStatus: 202, ack: { status: 'queued' }, messages };
}

function bumpsEpoch(event: string, envelope: Envelope, payload: JsonObject): boolean {
  if (EPOCH_EVENTS.has(event)) {
    return true;
  }
  const defaultBranch = envelope.repository?.defaultBranch ?? null;
  return event === 'push' && defaultBranch !== null && pushRefOf(payload) === `refs/heads/${defaultBranch}`;
}

/**
 * The PM's answer to an owner request (#219, ADR 0005 decision 3): an `issue_comment.created` whose first line is a
 * strict handled marker by the team's app marks the named request of this project and issue, if it came after it.
 * No push: the PM's comment is on the issue. Whether the row exists and is older is the repository's check.
 */
async function markRequestHandled(
  db: D1Database,
  slug: string,
  envelope: Envelope,
  payload: JsonObject,
): Promise<boolean> {
  if (envelope.action !== 'created') {
    return false;
  }
  const comment = commentOf(payload);
  const issue = issueOf(payload);
  if (comment === null || issue === null) {
    return false;
  }
  const handled = handledRequestOf(
    {
      id: comment.id,
      body: comment.body,
      authorLogin: comment.author.authorLogin,
      authorType: comment.author.authorType,
      createdAt: comment.createdAt,
      // A `created` delivery is the comment as first written; edits arrive as `edited` and are never read.
      updatedAt: null,
    },
    false,
  );
  if (handled === null) {
    return false;
  }
  return new OwnerRequestsRepo(db).markHandled({ ...handled, slug, issueNumber: issue.number });
}

/**
 * The project a repository delivery is for (ADR 0008 decision 2): by the repository **id**, never by `full_name`,
 * so a rename or a transfer cannot land on another account's project. A row registered before 0018 has no id yet;
 * its name and its registered installation still identify it, and this signed delivery records the id once (the
 * T-2 backfill) — a row that already has an id is never matched by name.
 */
async function projectOf(
  projects: ProjectsRepo,
  repository: { readonly id: number | null; readonly fullName: string },
  installationId: number | null,
  logger: Logger,
): Promise<ProjectRow | null> {
  if (repository.id === null) {
    return null;
  }
  const byId = await projects.findActiveByRepoId('github', repository.id);
  if (byId !== null) {
    return byId;
  }
  const byName = await projects.findActiveByRepo(repository.fullName);
  if (byName === null || byName.repo_id !== null || byName.installation_id !== installationId) {
    return null;
  }
  const recorded = await projects.setRepoId(byName.slug, repository.id);
  logger.info('project repo id backfilled', { slug: byName.slug, recorded });
  return recorded ? { ...byName, repo_id: repository.id } : null;
}

/**
 * `pull_requests` (#463, ADR 0006: the hooks Worker writes only `pull_requests`, `ci_state` and `cache_epoch`): a
 * pull request delivery upserts its row — unless the row holds a later change or the delivery's repository id is not
 * the project's — and a finished workflow run marks its head's CI stale. The delivery is signed, its text still
 * untrusted: the adapter's parse keeps only validated fields and builds the URL itself.
 */
async function syncPullRequests(
  db: D1Database,
  slug: string,
  event: string,
  payload: JsonObject,
  receivedAt: string,
): Promise<void> {
  const parsed = githubWebhooks.parse({ event, payload });
  if (parsed === null) {
    return;
  }
  const repositoryId = Number(parsed.repository.externalId);
  const pulls = new PullRequestsRepo(db);
  if ('pullRequest' in parsed) {
    await pulls.upsert(slug, parsed.pullRequest, { repositoryId, syncedAt: receivedAt });
  } else if (parsed.kind === 'ci.completed') {
    await pulls.markCiStale(slug, parsed.sha, repositoryId);
  }
}

/**
 * Steps 3–6 of the architect note: route to the project, bump its epoch, drop own writes, map to a push; then drop
 * it while the project is snoozed unless it is urgent and urgent ones are allowed (#221).
 */
async function handleRepositoryEvent(
  db: D1Database,
  event: string,
  envelope: Envelope,
  payload: JsonObject,
  nowMs: number,
  logger: Logger,
): Promise<Outcome> {
  if (envelope.repository === null) {
    return ignored('unregistered');
  }
  const projects = new ProjectsRepo(db);
  const row = await projectOf(projects, envelope.repository, envelope.installationId, logger);
  if (row === null) {
    return ignored('unregistered');
  }
  // ADR 0003 decision 5: the signature says "one of our app's installations", this says "the one we registered";
  // ADR 0008 decision 2: and that installation is linked to the project's account (`installations.account_id =
  // projects.account_id`), so a delivery never crosses accounts.
  if (row.installation_id === null || row.installation_id !== envelope.installationId) {
    return ignored('installation-mismatch');
  }
  const accountId = await linkedAccountOf(db, envelope.installationId);
  if (accountId !== row.account_id) {
    logger.warn('webhook refused', { reason: 'installation-account-mismatch', slug: row.slug });
    return ignored('installation-mismatch');
  }
  if (bumpsEpoch(event, envelope, payload)) {
    await projects.bumpCacheEpoch(row.slug);
  }
  if (event === 'pull_request' || event === 'workflow_run') {
    await syncPullRequests(db, row.slug, event, payload, new Date(nowMs).toISOString());
  }
  if (event === 'issue_comment') {
    const comment = commentOf(payload);
    if (comment !== null && (await new OwnWritesRepo(db).isOwnComment(comment.id))) {
      return ignored('own-write');
    }
    if (await markRequestHandled(db, row.slug, envelope, payload)) {
      return { httpStatus: 200, ack: { status: 'request-handled' }, messages: [] };
    }
  }
  const mapped = applySnooze(mapEvent(mappedProjectOf(row), event, envelope, payload), {
    isSnoozed: isSnoozedAt(row, nowMs),
    allowsUrgent: row.snooze_allows_urgent !== 0,
  });
  if (mapped.kind === 'ignored') {
    return ignored(mapped.reason);
  }
  return { httpStatus: 202, ack: { status: 'queued' }, messages: [mapped.notification] };
}

function reject(c: WorkerContext<HooksEnv>, status: string, init: Parameters<typeof problem>[1]): Response {
  c.get('logger').warn('webhook rejected', { status });
  return problem(c, init);
}

/**
 * `POST /hooks/github` — the GitHub App's deliveries (#12). Every step ends the request; nothing touches D1
 * before the signature verified, and nothing after the dedupe row can turn a push failure into a 5xx.
 */
export function githubWebhookRoutes(deps: GitHubWebhookDeps): Hono<WorkerHonoEnv<HooksEnv>> {
  const now = deps.now ?? (() => new Date());

  return new Hono<WorkerHonoEnv<HooksEnv>>().all('/', async (c) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return reject(c, 'rejected:method', {
        type: 'method-not-allowed',
        title: 'Method Not Allowed',
        status: 405,
      });
    }
    const secrets = webhookSecretsOf(c.env.WEBHOOK_SECRET, c.env.WEBHOOK_SECRET_PREVIOUS);
    if (secrets === null) {
      return reject(c, 'rejected:misconfigured', {
        type: 'webhook-misconfigured',
        title: 'Webhook receiver is not configured',
        status: 503,
      });
    }
    const body = await readBodyCapped(c.req.raw, WEBHOOK_BODY_MAX_BYTES);
    if (!body.ok) {
      return reject(c, 'rejected:too-large', {
        type: 'payload-too-large',
        title: 'Payload Too Large',
        status: 413,
      });
    }
    if (!(await githubWebhooks.verify(body.bytes, c.req.header('x-hub-signature-256'), secrets))) {
      return reject(c, 'rejected:signature', {
        type: 'webhook-signature',
        title: 'Unauthorized',
        status: 401,
      });
    }

    const event = c.req.header('x-github-event') ?? '';
    const deliveryId = c.req.header('x-github-delivery') ?? '';
    if (!EVENT_NAME.test(event) || !DELIVERY_ID.test(deliveryId)) {
      return reject(c, 'rejected:headers', { type: 'webhook-headers', title: 'Bad Request', status: 400 });
    }
    const logger = c.get('logger');
    const answer = (outcome: Outcome, repo: string): Response => {
      logger.info('webhook delivery', { deliveryId, event, repo, status: statusLabelOf(outcome.ack) });
      return c.json(outcome.ack, outcome.httpStatus);
    };
    if (event === 'ping') {
      return answer({ httpStatus: 200, ack: { status: 'pong' }, messages: [] }, '');
    }
    if (!HANDLED_EVENTS.has(event)) {
      return answer(ignored('unhandled-event'), '');
    }
    const payload = parseJsonObject(body.bytes);
    if (payload === null) {
      return reject(c, 'rejected:payload', { type: 'webhook-payload', title: 'Bad Request', status: 400 });
    }

    const envelope = envelopeOf(payload);
    const repo = envelope.repository?.fullName ?? '';
    const receivedAt = now();
    const deliveries = new WebhookDeliveriesRepo(c.env.DB);
    const record = await deliveries.record({
      deliveryId,
      event,
      repo,
      bodySha256: await sha256Hex(body.bytes),
      receivedAt: receivedAt.toISOString(),
    });
    if (!record.fresh) {
      return answer({ httpStatus: 200, ack: { status: 'duplicate' }, messages: [] }, repo);
    }
    if (record.rowId % PRUNE_EVERY === 0) {
      c.executionCtx.waitUntil(pruneDeliveries(deliveries, receivedAt, logger));
    }

    let outcome: Outcome;
    try {
      outcome =
        event === 'installation' || event === 'installation_repositories'
          ? await handleInstallation(c.env.DB, event, envelope, payload, receivedAt.toISOString())
          : await handleRepositoryEvent(c.env.DB, event, envelope, payload, receivedAt.getTime(), logger);
    } catch (error: unknown) {
      // Without its dedupe row, GitHub's redelivery of this delivery is processed instead of answered `duplicate`.
      try {
        await deliveries.forget(deliveryId);
      } catch (forgetError: unknown) {
        logger.error('webhook delivery could not be released', {
          deliveryId,
          error: forgetError instanceof Error ? forgetError.name : 'unknown',
        });
      }
      throw error;
    }
    if (outcome.messages.length > 0) {
      c.executionCtx.waitUntil(fanOut(deps.senders, c.env, outcome.messages, deliveryId, logger));
    }
    return answer(outcome, repo);
  });
}
