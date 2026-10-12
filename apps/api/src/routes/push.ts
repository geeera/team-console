import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  PUSH_MAX_SUBSCRIPTIONS,
  PUSH_TEST_INTERVAL_S,
  isEnvironment,
  type PushConfigDto,
  type PushDevicesDto,
  type PushSendResultDto,
} from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { PushSubscriptionsRepo, PushTestSendsRepo } from '@worker/db';
import {
  PushMisconfiguredError,
  PushSender,
  checkPushSubscription,
  checkVapidConfig,
  cleanPushText,
  isPushLanguage,
  pushFetch,
  testNotification,
  type FetchLike,
  type PushLanguage,
  type VapidConfig,
} from '@worker/push';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import { jsonBody } from '../json-body';
import { sha256Hex } from '../owner/owner-writer';

type Context = WorkerContext<ApiEnv>;

/** Threat model on #11, row 2: a subscription is well under 1 KB; nothing a push route accepts needs more. */
export const PUSH_MAX_BODY_BYTES = 4 * 1024;
const USER_AGENT_MAX_LENGTH = 256;
const DEFAULT_LANGUAGE: PushLanguage = 'ru';

export interface PushRoutesOptions {
  /** The transport of pushes; a test passes the fake push service. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidSubscription(c: Context, detail: string): Response {
  return problem(c, { type: 'push-invalid-subscription', title: 'Invalid push subscription', status: 422, detail });
}

function invalid(c: Context, detail: string): Response {
  return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail });
}

/** The VAPID identity, or the 503 that says push is not set up here; the log names settings, never values. */
function vapidOf(c: Context): VapidConfig | Response {
  const check = checkVapidConfig({
    publicKey: c.env.VAPID_PUBLIC_KEY,
    privateKey: c.env.VAPID_PRIVATE_KEY,
    subject: c.env.VAPID_SUBJECT,
  });
  if (check.ok) {
    return check.config;
  }
  c.get('logger').error('push misconfigured', { invalid: check.invalid });
  return problem(c, {
    type: 'push-misconfigured',
    title: 'Push is not configured',
    status: 503,
    detail: 'The VAPID key pair or subject is not set on this environment',
  });
}

function userAgentOf(c: Context): string | null {
  const header = c.req.header('User-Agent');
  if (header === undefined) {
    return null;
  }
  const cleaned = [...cleanPushText(header)].slice(0, USER_AGENT_MAX_LENGTH).join('');
  return cleaned === '' ? null : cleaned;
}

/**
 * Web push (#11; ADR 0001 decisions 3 and 5): `/api/v1/push/*`, behind the Access check and the same-origin rule of
 * #8 like every API route, and for the owner only — the CI service token may not add a device or send to one.
 */
export function createPushRoutes(options: PushRoutesOptions = {}): Hono<WorkerHonoEnv<ApiEnv>> {
  const now = options.now ?? Date.now;
  const limit = bodyLimit({
    maxSize: PUSH_MAX_BODY_BYTES,
    onError: (c) =>
      problem(c as Context, {
        type: 'payload-too-large',
        title: 'Payload Too Large',
        status: 413,
        detail: `Push request bodies are at most ${String(PUSH_MAX_BODY_BYTES)} bytes`,
      }),
  });
  const baseFetch: FetchLike = options.fetch ?? (async (input, init) => fetch(input, init));

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .use('*', ownerOnlyMiddleware)

    .get('/config', (c) => {
      const vapid = vapidOf(c);
      if (vapid instanceof Response) {
        return vapid;
      }
      const body: PushConfigDto = { publicKey: vapid.publicKey };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .get('/subscriptions', async (c) => {
      const rows = await new PushSubscriptionsRepo(c.env.DB).list();
      const body: PushDevicesDto = {
        devices: await Promise.all(
          rows.map(async (row) => ({
            id: await sha256Hex(row.endpoint),
            service: new URL(row.endpoint).host,
            userAgent: row.userAgent,
            createdAt: row.createdAt,
            lastSuccessAt: row.lastSuccessAt,
            failures: row.failures,
          })),
        ),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .put('/subscriptions', limit, async (c) => {
      const check = checkPushSubscription(await jsonBody(c));
      if (!check.ok) {
        c.get('logger').warn('push subscription refused', { reason: check.reason });
        return invalidSubscription(c, check.reason);
      }
      const evicted = await new PushSubscriptionsRepo(c.env.DB).upsert(
        { ...check.subscription, userAgent: userAgentOf(c) },
        new Date(now()).toISOString(),
        PUSH_MAX_SUBSCRIPTIONS,
      );
      c.get('logger').info('push subscription stored', {
        pushService: new URL(check.subscription.endpoint).host,
        evicted,
      });
      return c.body(null, 204);
    })

    .delete('/subscriptions', limit, async (c) => {
      const body = await jsonBody(c);
      const endpoint = isRecord(body) ? body['endpoint'] : undefined;
      const id = isRecord(body) ? body['id'] : undefined;
      const repo = new PushSubscriptionsRepo(c.env.DB);
      if (typeof endpoint === 'string' && id === undefined) {
        await repo.remove(endpoint);
        return c.body(null, 204);
      }
      if (typeof id === 'string' && endpoint === undefined && /^[0-9a-f]{64}$/.test(id)) {
        for (const row of await repo.list()) {
          if ((await sha256Hex(row.endpoint)) === id) {
            await repo.remove(row.endpoint);
          }
        }
        return c.body(null, 204);
      }
      return invalid(c, 'The body must be { "endpoint": string } or { "id": a device id }');
    })

    .post('/test', limit, async (c) => {
      const logger = c.get('logger');
      const body = await jsonBody(c);
      let language = DEFAULT_LANGUAGE;
      if (isRecord(body) && body['language'] !== undefined) {
        if (!isPushLanguage(body['language'])) {
          return invalid(c, 'language must be "ru" or "en"');
        }
        language = body['language'];
      } else if (body !== undefined && !isRecord(body)) {
        return invalid(c, 'The body must be an object or empty');
      }

      const vapid = vapidOf(c);
      if (vapid instanceof Response) {
        return vapid;
      }
      let transport: FetchLike;
      try {
        transport = pushFetch(c.env, baseFetch);
      } catch (error: unknown) {
        if (!(error instanceof PushMisconfiguredError)) {
          throw error;
        }
        logger.error('push misconfigured', { invalid: ['PUSH_FAKE_ORIGIN'] });
        return problem(c, { type: 'push-misconfigured', title: 'Push is not configured', status: 503 });
      }
      // The title prefix (#237) depends on it: never guess production for an unknown value.
      const environment: string = c.env.ENVIRONMENT;
      if (!isEnvironment(environment)) {
        logger.error('push misconfigured', { invalid: ['ENVIRONMENT'] });
        return problem(c, { type: 'push-misconfigured', title: 'Push is not configured', status: 503 });
      }

      const claim = await new PushTestSendsRepo(c.env.DB).claim(now(), PUSH_TEST_INTERVAL_S * 1000);
      if (!claim.claimed) {
        return problem(c, {
          type: 'push-test-too-soon',
          title: 'A test was sent moments ago',
          status: 429,
          detail: `One test push per ${String(PUSH_TEST_INTERVAL_S)} seconds`,
          retryAfter: Math.max(1, Math.ceil(claim.retryAfterMs / 1000)),
        });
      }

      const sender = new PushSender({ vapid, fetch: transport, logger, now, environment });
      const result: PushSendResultDto = await sender.sendToAll(
        new PushSubscriptionsRepo(c.env.DB),
        testNotification(language),
      );
      c.header('Cache-Control', 'no-store');
      return c.json(result);
    });
}
