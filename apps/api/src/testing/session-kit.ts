import { env } from 'cloudflare:test';
import type { MemberRole } from '@shared/contracts';
import { sessionIdHashOf } from '@worker/db';
import { SESSION_COOKIE } from '../auth/session';
import type { ApiEnv } from '../env';
import { accessEnv, fetchApi, uniqueTeamDomain, type ApiRequest } from './access-kit';
import { newKey } from './tracker-kit';

/**
 * Test-only: a second (and third) account with a signed-in user, as T-3's sign-in will leave them in D1 (#466).
 * Requests go through the deployed-config env (`accessEnv`) with the session cookie and no Access JWT, so the
 * session door is what admits them.
 */

let counter = 0;

function ulid(prefix: string): string {
  counter += 1;
  // Crockford base32 only (no I, L, O, U): the 0018 CHECK refuses anything else.
  const tail = String(counter).padStart(6, '0');
  return `01M6YSNJ0000000000${prefix}${tail}`.slice(0, 26).padEnd(26, '0');
}

export interface SeededAccount {
  readonly id: string;
  readonly slug: string;
}

export async function seedAccount(name = 'Account'): Promise<SeededAccount> {
  const id = ulid('AK');
  const slug = `acct-${String(counter)}-${crypto.randomUUID().slice(0, 6)}`;
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, ?2, ?3, '2026-11-10T00:00:00.000Z')`,
  )
    .bind(id, slug, name)
    .run();
  return { id, slug };
}

export async function seedUser(login = 'user'): Promise<string> {
  const id = ulid('VS');
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
     VALUES (?1, 'github', ?2, ?3, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`,
  )
    .bind(id, String(100000 + counter), `${login}-${String(counter)}`)
    .run();
  return id;
}

export async function seedMembership(accountId: string, userId: string, role: MemberRole): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, '2026-11-10T00:00:00.000Z')`,
  )
    .bind(accountId, userId, role)
    .run();
}

/** A live session of the user; the cookie value (the opaque id), of which D1 holds only the hash. */
export async function seedSession(
  userId: string,
  options: { readonly expiresAt?: string; readonly revokedAt?: string } = {},
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const id = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?1, ?2, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', ?3, ?4)`,
  )
    .bind(
      await sessionIdHashOf(id),
      userId,
      options.expiresAt ?? '2099-01-01T00:00:00.000Z',
      options.revokedAt ?? null,
    )
    .run();
  return id;
}

export interface SessionUser {
  readonly userId: string;
  readonly cookie: string;
  readonly account: SeededAccount;
}

/** A user signed in to a fresh account with `role`. */
export async function seedSessionUser(role: MemberRole = 'owner'): Promise<SessionUser> {
  const account = await seedAccount();
  const userId = await seedUser(role);
  await seedMembership(account.id, userId, role);
  return { userId, cookie: await seedSession(userId), account };
}

/** A project of the account, on GitHub Issues unless `tracker` says otherwise. */
export async function seedAccountProject(
  account: SeededAccount,
  options: { readonly tracker?: 'console'; readonly repoId?: number } = {},
): Promise<{ slug: string; keyPrefix: string | null }> {
  counter += 1;
  const slug = `a${String(counter)}-${crypto.randomUUID().slice(0, 6)}`;
  const keyPrefix =
    options.tracker === 'console'
      ? `Q${String.fromCharCode(65 + (counter % 26))}${String.fromCharCode(65 + (Math.floor(counter / 26) % 26))}`
      : null;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, repo_id, installation_id, tracker, key_prefix)
     VALUES (?1, ?2, ?3, 0, '2026-11-10T00:00:00.000Z', ?4, ?5, 4711, ?6, ?7)`,
  )
    .bind(
      slug,
      `acme/${slug}`,
      slug,
      account.id,
      options.repoId ?? null,
      options.tracker ?? 'github',
      keyPrefix,
    )
    .run();
  return { slug, keyPrefix };
}

/**
 * A request as a signed-in user: the cookie, same-origin JSON on writes, a fresh `Idempotency-Key`, no JWT. The
 * deployed-config bindings by default; a spec whose fixtures are sealed for `local` passes
 * `localEnv({ AUTH_MODE: undefined })` (no bypass, so the session door is still what admits the user).
 */
export async function sendAsSession(
  user: Pick<SessionUser, 'cookie'>,
  method: string,
  path: string,
  body?: unknown,
  extra: Partial<ApiRequest> = {},
  bindings: ApiEnv = accessEnv(uniqueTeamDomain()),
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${user.cookie}` };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Sec-Fetch-Site'] = 'same-origin';
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = newKey();
  }
  const { headers: extraHeaders, ...rest } = extra;
  return fetchApi(path, bindings, {
    method,
    headers: { ...headers, ...extraHeaders },
    ...(body === undefined || method === 'GET'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...rest,
  });
}
