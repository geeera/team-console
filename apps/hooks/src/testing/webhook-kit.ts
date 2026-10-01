import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createHooksApp } from '../app';
import type { HooksEnv } from '../env';
import type { PushFanOut, PushMessage, PushSender } from '../push/push-sender';

/** A test-only value; real secrets come from `wrangler secret put`. */
export const TEST_WEBHOOK_SECRET = 'hooks-spec-key';
export const TEST_INSTALLATION_ID = 4711;
export const ORIGIN = 'http://hooks.test';

const encoder = new TextEncoder();

export async function signatureOf(body: string | Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Records what the Worker would push; `failWith` makes every send throw. */
export class RecordingPushSender implements PushSender {
  readonly messages: PushMessage[] = [];

  constructor(private readonly failWith?: Error) {}

  sendToAll(message: PushMessage): Promise<PushFanOut> {
    this.messages.push(message);
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve({ sent: 1, pruned: 0, failed: 0 });
  }
}

export interface DeliverOptions {
  readonly event?: string;
  readonly deliveryId?: string;
  /** Signs with this secret instead of the test secret. */
  readonly signWith?: string;
  /** Sends this header verbatim (`null` = no header) instead of a computed signature. */
  readonly signature?: string | null;
  /** Overrides; `undefined` removes a binding, e.g. the secret. */
  readonly env?: { readonly [K in keyof HooksEnv]?: HooksEnv[K] | undefined };
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly pushSender?: PushSender;
  readonly now?: () => Date;
}

export interface Delivered {
  readonly response: Response;
  /** Parsed JSON log lines written during the request, `waitUntil` work included. */
  readonly logs: readonly Record<string, unknown>[];
  readonly rawLogs: readonly string[];
}

let deliveryCounter = 0;

/** A fresh GUID-shaped delivery id per call, like GitHub's. */
export function nextDeliveryId(): string {
  deliveryCounter += 1;
  return `00000000-0000-4000-8000-${String(deliveryCounter).padStart(12, '0')}`;
}

/** Posts one delivery through the real app (all middleware), signed like GitHub signs it, and waits for `waitUntil`. */
export async function deliver(body: unknown, options: DeliverOptions = {}): Promise<Delivered> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const rawLogs: string[] = [];
  const app = createHooksApp({
    logSink: (line) => rawLogs.push(line),
    ...(options.pushSender === undefined ? {} : { pushSender: options.pushSender }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const signature =
    options.signature === undefined
      ? await signatureOf(raw, options.signWith ?? TEST_WEBHOOK_SECRET)
      : options.signature;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': options.event ?? 'issues',
    'x-github-delivery': options.deliveryId ?? nextDeliveryId(),
    ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
    ...options.headers,
  };
  const method = options.method ?? 'POST';
  const request = new Request(`${ORIGIN}/hooks/github`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: raw }),
  });
  const ctx = createExecutionContext();
  const response = await app.fetch(
    request,
    { ...env, WEBHOOK_SECRET: TEST_WEBHOOK_SECRET, ...options.env },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, rawLogs, logs: rawLogs.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

export async function seedProject(
  slug: string,
  repo: string,
  options: { installationId?: number | null; archivedAt?: string; displayName?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, installation_id, added_at, archived_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      slug,
      repo,
      options.displayName ?? slug,
      options.installationId === undefined ? TEST_INSTALLATION_ID : options.installationId,
      '2026-10-01T00:00:00Z',
      options.archivedAt ?? null,
    )
    .run();
}

export async function cacheEpochOf(slug: string): Promise<number | undefined> {
  const row = await env.DB.prepare('SELECT cache_epoch FROM projects WHERE slug = ?1')
    .bind(slug)
    .first<{ cache_epoch: number }>();
  return row?.cache_epoch;
}

export async function deliveryCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM webhook_deliveries').first<{ n: number }>();
  return row?.n ?? -1;
}

export async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM webhook_deliveries'),
    env.DB.prepare('DELETE FROM own_writes'),
    env.DB.prepare('DELETE FROM projects'),
  ]);
}
