import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import { createApiApp } from '../app';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import type { FetchLike } from '@worker/routines';

/** Test-only: a local stand-in for a Cloudflare Access team (RSA key, JWKS endpoint, token signer). */

export const OWNER = 'owner@example.com';
export const AUDIENCE = 'aud-dev-0123456789abcdef';
export const SERVICE_TOKEN_ID = 'playwright-client.access';

let domainCounter = 0;

/**
 * jose caches a key set per JWKS URL for the isolate's lifetime, so each case gets its own team domain and
 * therefore a cold cache — no test sees keys fetched by another.
 */
export function uniqueTeamDomain(): string {
  domainCounter += 1;
  return `team-${domainCounter}-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
}

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export async function createSigningKey(kid = crypto.randomUUID()): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, publicJwk };
}

export interface TokenOptions {
  readonly issuer?: string;
  readonly audience?: string | string[];
  readonly expiresInSeconds?: number | null;
  readonly notBeforeInSeconds?: number;
  readonly issuedAt?: boolean;
  readonly claims?: JWTPayload;
}

/** A token shaped like Access's: RS256, `kid`, `iss` = team URL, `aud` array, `iat`/`nbf`/`exp`. */
export async function signAccessToken(
  key: SigningKey,
  teamDomain: string,
  options: TokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: OWNER, type: 'app', ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(options.issuer ?? `https://${teamDomain}`)
    .setAudience(options.audience ?? [AUDIENCE])
    .setSubject('owner-sub');
  if (options.issuedAt !== false) {
    jwt.setIssuedAt(now);
  }
  if (options.notBeforeInSeconds !== undefined) {
    jwt.setNotBefore(now + options.notBeforeInSeconds);
  }
  const expiresIn = options.expiresInSeconds === undefined ? 600 : options.expiresInSeconds;
  if (expiresIn !== null) {
    jwt.setExpirationTime(now + expiresIn);
  }
  return jwt.sign(key.privateKey);
}

export function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type JwksReply = { readonly keys: readonly JWK[] } | { readonly status: number };

export interface JwksServer {
  /** Replace what a domain's `/cdn-cgi/access/certs` answers (key rotation, outage). */
  set(teamDomain: string, reply: JwksReply): void;
  /** How many times a domain's JWKS was fetched. */
  fetchCount(teamDomain: string): number;
}

/**
 * Stubs global `fetch` for JWKS URLs only; any other outbound request fails the test loudly. Restored by
 * `vi.restoreAllMocks()` in the spec's afterEach.
 */
export function stubJwksServer(): JwksServer {
  const replies = new Map<string, JwksReply>();
  const counts = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const reply = url.pathname === '/cdn-cgi/access/certs' ? replies.get(url.hostname) : undefined;
    if (reply === undefined) {
      throw new Error(`unexpected outbound fetch in a test: ${url.href}`);
    }
    counts.set(url.hostname, (counts.get(url.hostname) ?? 0) + 1);
    return 'status' in reply
      ? new Response('upstream error', { status: reply.status })
      : Response.json({ keys: reply.keys });
  });
  return {
    set: (teamDomain, reply) => replies.set(teamDomain, reply),
    fetchCount: (teamDomain) => counts.get(teamDomain) ?? 0,
  };
}

/** Bindings of a deployed dev Worker with Access configured — no local bypass. */
export function accessEnv(
  teamDomain: string,
  overrides: Partial<Record<keyof ApiEnv, string | undefined>> = {},
): ApiEnv {
  return {
    ...env,
    ENVIRONMENT: 'dev',
    AUTH_MODE: undefined,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: AUDIENCE,
    OWNER_EMAIL: OWNER,
    ALLOW_SERVICE_TOKEN: 'true',
    ACCESS_SERVICE_TOKEN_ID: SERVICE_TOKEN_ID,
    ...overrides,
  } as ApiEnv;
}

export interface ApiRequest {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** The origin the request is sent to (default `http://api.test`), for routes that read their own origin. */
  readonly origin?: string;
  readonly logSink?: (line: string) => void;
  /** Shared across calls so the token and read caches behave as in one isolate. */
  readonly github?: ApiGitHub;
  /** Replaces the registry's owner source (by default the #59 connection in D1). */
  readonly ownerConnection?: OwnerConnectionSource;
  /** The fake routines API's fetch (#114). */
  readonly routinesFetch?: FetchLike;
  readonly routinesDeadlineMs?: number;
  /** The fake push service's fetch (#11). */
  readonly pushFetch?: FetchLike;
  readonly pushNow?: () => number;
}

/** Calls the app directly so each case chooses its own bindings (`SELF` is fixed to the pool's local ones). */
export async function fetchApi(path: string, bindings: ApiEnv, request: ApiRequest = {}): Promise<Response> {
  const ctx = createExecutionContext();
  // Silent by default; a case that asserts on logs passes its own sink.
  const app = createApiApp({
    logSink: request.logSink ?? (() => undefined),
    ...(request.github === undefined ? {} : { github: request.github }),
    ...(request.ownerConnection === undefined ? {} : { ownerConnection: request.ownerConnection }),
    ...(request.routinesFetch === undefined ? {} : { routinesFetch: request.routinesFetch }),
    ...(request.routinesDeadlineMs === undefined ? {} : { routinesDeadlineMs: request.routinesDeadlineMs }),
    ...(request.pushFetch === undefined ? {} : { pushFetch: request.pushFetch }),
    ...(request.pushNow === undefined ? {} : { pushNow: request.pushNow }),
  });
  const init: RequestInit = { method: request.method ?? 'GET', headers: request.headers ?? {} };
  if (request.body !== undefined) {
    init.body = request.body;
  }
  const response = await app.fetch(new Request(`${request.origin ?? 'http://api.test'}${path}`, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
