import { Hono } from 'hono';
import { problem, type Logger, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { OwnWritesRepo, ProjectsRepo, WebhookDeliveriesRepo, type ProjectRow } from '@worker/db';
import type { HooksEnv } from '../env';
import { WEBHOOK_BODY_MAX_BYTES, readBodyCapped } from '../github/body';
import {
  commentOf,
  envelopeOf,
  isJsonObject,
  pushRefOf,
  repositoriesOf,
  type Envelope,
  type JsonObject,
} from '../github/payload';
import { sha256Hex, verifySignature, webhookSecretsOf } from '../github/signature';
import { mapEvent, pushMessageOf, settingsLinkOf, type MappedProject } from '../mapping/map-event';
import type { PushLanguage, PushMessage, PushSender } from '../push/push-sender';

/** The answer GitHub gets; only its status code matters to GitHub, the body is for the delivery log. */
export interface WebhookAck {
  readonly status: 'pong' | 'duplicate' | 'ignored' | 'queued' | 'updated';
  readonly reason?: IgnoredReason;
}

export type IgnoredReason =
  | 'unhandled-event'
  | 'unregistered'
  | 'installation-mismatch'
  | 'own-write'
  | 'untrusted-author'
  | 'no-notification';

export interface GitHubWebhookDeps {
  readonly pushSender: PushSender;
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
  readonly messages: readonly PushMessage[];
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
  sender: PushSender,
  messages: readonly PushMessage[],
  deliveryId: string,
  logger: Logger,
): Promise<void> {
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
  logger.info('push fan-out', { sent, pruned, failed, deliveryId });
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

/** `installation_repositories` and `installation`: keep `projects.access_lost_at` in step (ADR 0003 decision 5). */
async function handleInstallation(
  projects: ProjectsRepo,
  event: string,
  envelope: Envelope,
  payload: JsonObject,
  receivedAt: string,
): Promise<Outcome> {
  const installationId = envelope.installationId;
  if (installationId === null) {
    return ignored('installation-mismatch');
  }
  let lost: ProjectRow[] = [];
  if (event === 'installation_repositories' && envelope.action === 'removed') {
    for (const repo of repositoriesOf(payload, 'repositories_removed')) {
      lost.push(...(await projects.markAccessLost(repo, installationId, receivedAt)));
    }
  } else if (event === 'installation_repositories' && envelope.action === 'added') {
    let restored = 0;
    for (const repo of repositoriesOf(payload, 'repositories_added')) {
      restored += (await projects.clearAccessLost(repo, installationId)).length;
    }
    return restored === 0
      ? ignored('unregistered')
      : { httpStatus: 200, ack: { status: 'updated' }, messages: [] };
  } else if (event === 'installation' && envelope.action === 'deleted') {
    lost = await projects.markInstallationLost(installationId, receivedAt);
  } else {
    return ignored('no-notification');
  }
  if (lost.length === 0) {
    return ignored('unregistered');
  }
  const messages = lost.map((row) =>
    pushMessageOf(mappedProjectOf(row), 'access-lost', settingsLinkOf(row.slug), { repo: row.repo }),
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

/** Steps 3–6 of the architect note: route to the project, bump its epoch, drop own writes, map to a push. */
async function handleRepositoryEvent(
  db: D1Database,
  event: string,
  envelope: Envelope,
  payload: JsonObject,
): Promise<Outcome> {
  if (envelope.repository === null) {
    return ignored('unregistered');
  }
  const projects = new ProjectsRepo(db);
  const row = await projects.findActiveByRepo(envelope.repository.fullName);
  if (row === null) {
    return ignored('unregistered');
  }
  // ADR 0003 decision 5: the signature says "one of our app's installations", this says "the one we registered".
  if (row.installation_id === null || row.installation_id !== envelope.installationId) {
    return ignored('installation-mismatch');
  }
  if (bumpsEpoch(event, envelope, payload)) {
    await projects.bumpCacheEpoch(row.slug);
  }
  if (event === 'issue_comment') {
    const comment = commentOf(payload);
    if (comment !== null && (await new OwnWritesRepo(db).isOwnComment(comment.id))) {
      return ignored('own-write');
    }
  }
  const mapped = mapEvent(mappedProjectOf(row), event, envelope, payload);
  if (mapped.kind === 'ignored') {
    return ignored(mapped.reason);
  }
  return { httpStatus: 202, ack: { status: 'queued' }, messages: [mapped.message] };
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
    if (!(await verifySignature(secrets, body.bytes, c.req.header('x-hub-signature-256')))) {
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
          ? await handleInstallation(
              new ProjectsRepo(c.env.DB),
              event,
              envelope,
              payload,
              receivedAt.toISOString(),
            )
          : await handleRepositoryEvent(c.env.DB, event, envelope, payload);
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
      c.executionCtx.waitUntil(fanOut(deps.pushSender, outcome.messages, deliveryId, logger));
    }
    return answer(outcome, repo);
  });
}
