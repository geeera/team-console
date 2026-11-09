import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createHooksApp } from '../app';
import type { HooksEnv } from '../env';
import { OWNER_ACCOUNT_ID, PUSH_MAX_SUBSCRIPTIONS } from '@shared/contracts';
import { InstallationsRepo, PushSubscriptionsRepo } from '@worker/db';
import {
  decodeBase64Url,
  encodeBase64Url,
  type FetchLike,
  type PushNotification,
  type PushSendResult,
} from '@worker/push';
import type { FakePushService } from '@worker/push/testing';
import type { NotificationSender, NotificationSenderFactory } from '../push/push-sender';

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

/** Records what the Worker would push instead of sending it; `failWith` makes every send throw. */
export class RecordingPushSender implements NotificationSender {
  readonly messages: PushNotification[] = [];
  readonly senders: NotificationSenderFactory = () => this;

  constructor(private readonly failWith?: Error) {}

  sendToAll(notification: PushNotification): Promise<PushSendResult> {
    this.messages.push(notification);
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve({ sent: 1, pruned: 0, failed: 0 });
  }
}

/** The deep link a notification opens. */
export function linkOf(notification: PushNotification): string {
  return notification.notification.data.onActionClick.default.url;
}

let vapidPair: Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string }> | undefined;

/** A VAPID pair for this test run only (the deployed one is a Worker secret nobody reads). */
export function testVapidBindings(): Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string }> {
  vapidPair ??= (async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    const x = decodeBase64Url(jwk.x ?? '');
    const y = decodeBase64Url(jwk.y ?? '');
    if (x === null || y === null) {
      throw new Error('the generated VAPID key has no public point');
    }
    const point = new Uint8Array([0x04, ...x, ...y]);
    return { VAPID_PUBLIC_KEY: encodeBase64Url(point), VAPID_PRIVATE_KEY: jwk.d ?? '' };
  })();
  return vapidPair;
}

/** Registers a device of the fake push service as the owner's subscription, like `PUT /api/v1/push/subscriptions`. */
export async function subscribeFakeDevice(service: FakePushService): Promise<string> {
  const subscription = await service.subscribe();
  await new PushSubscriptionsRepo(env.DB).upsert(
    {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: null,
    },
    new Date().toISOString(),
    PUSH_MAX_SUBSCRIPTIONS,
  );
  return subscription.endpoint;
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
  /** Records instead of sending; without it the real web push sender runs over `pushFetch`. */
  readonly pushSender?: RecordingPushSender;
  /** The transport of the real sender, e.g. a `FakePushService`'s `fetch`. Defaults to one that refuses. */
  readonly pushFetch?: FetchLike;
  readonly now?: () => Date;
}

export interface Delivered {
  readonly response: Response;
  /** Parsed JSON log lines written during the request, `waitUntil` work included. */
  readonly logs: readonly Record<string, unknown>[];
  readonly rawLogs: readonly string[];
}

// No spec may reach a real push service.
const refuseNetwork: FetchLike = () => Promise.reject(new TypeError('network disabled in hooks specs'));

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
    ...(options.pushSender === undefined ? {} : { senders: options.pushSender.senders }),
    pushFetch: options.pushFetch ?? refuseNetwork,
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
  const bindings = {
    ...env,
    ...(await testVapidBindings()),
    VAPID_SUBJECT: 'https://github.com/geeera/team-console',
    WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ...options.env,
  };
  const response = await app.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return { response, rawLogs, logs: rawLogs.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/**
 * The repository id GitHub would send for `owner/name` (`payloads.ts` uses the same), stable and case-insensitive
 * as GitHub's ids are to renames of case; distinct per repository.
 */
export function repoIdOf(repo: string): number {
  let hash = 7;
  for (const char of repo.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return 800_000 + hash;
}

let accountCounter = 0;

/** A second account (ADR 0008 decision 1), for the two-account cases; never the owner's. */
export async function seedAccount(): Promise<string> {
  accountCounter += 1;
  const id = `01M6YSNJ0000000000HK${String(accountCounter).padStart(6, '0')}`;
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, ?2, 'Other', '2026-10-01T00:00:00Z')`,
  )
    .bind(id, `hooks-acct-${String(accountCounter)}`)
    .run();
  return id;
}

/** Links the installation to the account as the registry does (`InstallationsRepo.link`); the invariant's input. */
export async function linkInstallation(installationId: number, accountId = OWNER_ACCOUNT_ID): Promise<void> {
  const result = await new InstallationsRepo(env.DB).link({
    accountId,
    provider: 'github',
    installationId: String(installationId),
    accountLogin: 'geeera',
    linkedByUserId: null,
    at: '2026-10-01T00:00:00Z',
  });
  if (result === 'linked-elsewhere') {
    throw new Error(`installation ${String(installationId)} is linked to another account in this spec`);
  }
}

export async function seedProject(
  slug: string,
  repo: string,
  options: {
    installationId?: number | null;
    archivedAt?: string;
    displayName?: string;
    accountId?: string;
    /** `null`: a row registered before 0018, with no repository id yet (the backfill case). */
    repoId?: number | null;
    /** `false`: the row's installation is left unlinked (the invariant's refusal case). */
    link?: boolean;
  } = {},
): Promise<void> {
  const installationId = options.installationId === undefined ? TEST_INSTALLATION_ID : options.installationId;
  const accountId = options.accountId ?? OWNER_ACCOUNT_ID;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, installation_id, added_at, archived_at, account_id, repo_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      slug,
      repo,
      options.displayName ?? slug,
      installationId,
      '2026-10-01T00:00:00Z',
      options.archivedAt ?? null,
      accountId,
      options.repoId === undefined ? repoIdOf(repo) : options.repoId,
    )
    .run();
  if (installationId !== null && options.link !== false) {
    await linkInstallation(installationId, accountId);
  }
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
    env.DB.prepare('DELETE FROM installations'),
    env.DB.prepare('DELETE FROM push_subscriptions'),
    env.DB.prepare('DELETE FROM owner_requests'),
  ]);
}
