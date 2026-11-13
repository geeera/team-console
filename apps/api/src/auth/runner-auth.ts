import { decodeJwt, importJWK, jwtVerify, errors as joseErrors } from 'jose';
import { RUNNER_JWT_MAX_AGE_SECONDS, isRunnerId, runnerAudienceOf } from '@shared/contracts';
import { problem, sha256Hex, type Logger, type WorkerContext } from '@worker/core';
import { RateLimitsRepo, RunnersRepo, rateWindowOf, retryAfterOf, type RunnerRecord } from '@worker/db';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';

/**
 * The runner's own door (#467, ADR 0008 "Customer runner authentication without Access", threat model C4): on
 * `/api/v1/runner/*` an EdDSA runner JWT alone is the credential — signed by the key the runner generated at
 * enrolment, `sub` its id, `aud` this environment, `exp` at most five minutes after `iat`, `jti` never presented
 * twice — and nothing else is read there: no Access header, no cookie, no local bypass. Access in front of the
 * origin (dev/stage) is a perimeter the edge enforces; the Worker does not require it. Every accepted call is
 * rate-limited per runner id (D1 counters) and recorded as a sighting (presence, the new-country and two-pollers
 * alerts).
 */

export const RUNNER_PATH_PREFIX = '/api/v1/runner/';
export const ENROL_PATH = '/api/v1/runner/enrol';
/** The header a job's proxied call carries the runner JWT in (2-A's job token middleware). */
export const RUNNER_JWT_HEADER = 'X-Runner-Jwt';

/** Calls per runner id per minute; a runner polls every 20–60 s and heartbeats once a minute per job. */
export const RUNNER_RATE_LIMIT_PER_MINUTE = 120;
const CLOCK_TOLERANCE_SECONDS = 30;
const BEARER = /^Bearer[ ]+(\S+)$/;
const COUNTRY = /^[A-Z]{2}$/;

export function isRunnerPath(path: string): boolean {
  return path.startsWith(RUNNER_PATH_PREFIX);
}

export function isEnrolRequest(method: string, path: string): boolean {
  return method === 'POST' && path === ENROL_PATH;
}

export type RunnerIdentity = Extract<Identity, { kind: 'runner' }>;

export type RunnerRefusal =
  | 'runner-jwt-missing'
  | 'runner-jwt-invalid'
  | 'runner-jwt-expired'
  | 'runner-jwt-replayed'
  | 'runner-revoked'
  | 'runner-rate-limited';

export type RunnerVerification =
  | { readonly ok: true; readonly runner: RunnerRecord }
  | { readonly ok: false; readonly refusal: RunnerRefusal; readonly retryAfter?: number };

/** `Bearer <jwt>` of the `Authorization` header, or the value of `header` when a job call carries it apart. */
export function runnerJwtOf(value: string | undefined, bare = false): string | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const token = bare ? value.trim() : BEARER.exec(value.trim())?.[1];
  return token === undefined || token === '' || token.length > 4096 ? null : token;
}

interface RunnerClaims {
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

function claimsOf(payload: Record<string, unknown>): RunnerClaims | null {
  const { sub, jti, iat, exp } = payload;
  if (
    !isRunnerId(sub) ||
    typeof jti !== 'string' ||
    jti.length === 0 ||
    jti.length > 128 ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    exp - iat > RUNNER_JWT_MAX_AGE_SECONDS ||
    exp <= iat
  ) {
    return null;
  }
  return { sub, jti, iat, exp };
}

/**
 * Verifies a runner JWT against the runner it names: signature by the enrolled key, audience, lifetime, replay,
 * revocation and the per-runner rate limit, in an order that reads D1 only for a well-formed token. Nothing of the
 * token is logged.
 */
export async function verifyRunnerJwt(
  c: WorkerContext<ApiEnv>,
  token: string,
  now: Date = new Date(),
): Promise<RunnerVerification> {
  let unverified: Record<string, unknown>;
  try {
    unverified = decodeJwt(token);
  } catch (error: unknown) {
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
      return { ok: false, refusal: 'runner-jwt-invalid' };
    }
    throw error;
  }
  const claims = claimsOf(unverified);
  if (claims === null) {
    return { ok: false, refusal: 'runner-jwt-invalid' };
  }
  const runners = new RunnersRepo(c.env.DB);
  const runner = await runners.findById(claims.sub);
  if (runner === null) {
    // An unknown id and a bad signature are one answer: a runner id is not enumerable through this door.
    return { ok: false, refusal: 'runner-jwt-invalid' };
  }
  // #489 review: `exp - iat ≤ 300` alone would admit a token minted with a future `iat` for as long as it says.
  // `maxTokenAge` refuses an `iat` older than five minutes or in the future (beyond the tolerance), and the ceiling
  // below refuses an `exp` further ahead than any honest token can carry, so a nonce row never outlives one window.
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp > nowSeconds + RUNNER_JWT_MAX_AGE_SECONDS + CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, refusal: 'runner-jwt-invalid' };
  }
  try {
    const key = await importJWK({ ...runner.publicKeyJwk }, 'EdDSA');
    await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      audience: runnerAudienceOf(c.env.ENVIRONMENT),
      subject: runner.id,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      maxTokenAge: RUNNER_JWT_MAX_AGE_SECONDS,
      requiredClaims: ['sub', 'aud', 'iat', 'exp', 'jti'],
    });
  } catch (error: unknown) {
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, refusal: 'runner-jwt-expired' };
    }
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
      return { ok: false, refusal: 'runner-jwt-invalid' };
    }
    throw error;
  }
  if (runner.revokedAt !== null) {
    return { ok: false, refusal: 'runner-revoked' };
  }
  const limit = await new RateLimitsRepo(c.env.DB).hit(
    `runner:${runner.id}`,
    rateWindowOf(now.getTime(), 60),
    RUNNER_RATE_LIMIT_PER_MINUTE,
  );
  if (!limit.allowed) {
    return { ok: false, refusal: 'runner-rate-limited', retryAfter: retryAfterOf(now.getTime(), 60) };
  }
  const nowIso = now.toISOString();
  const expiresAt = new Date((claims.exp + CLOCK_TOLERANCE_SECONDS) * 1000).toISOString();
  if (!(await runners.consumeNonce(runner.id, claims.jti, expiresAt, nowIso))) {
    return { ok: false, refusal: 'runner-jwt-replayed' };
  }
  return { ok: true, runner };
}

/** Where a runner call came from: the edge's country and a hash of its address (never the address itself). */
export async function sightingOf(
  c: WorkerContext<ApiEnv>,
  at: string,
): Promise<{ at: string; country: string | null; ipHash: string | null }> {
  const country = c.req.header('CF-IPCountry')?.trim().toUpperCase() ?? '';
  const ip = c.req.header('CF-Connecting-IP')?.trim() ?? '';
  return {
    at,
    country: COUNTRY.test(country) ? country : null,
    ipHash: ip === '' ? null : await sha256Hex(ip),
  };
}

/**
 * Records the call on the runner and audits an alert it raised (threat model C4: a claim from a new country, two
 * pollers on one runner id). The owner reads it on Settings › Runners and in the account audit; a push follows once
 * push subscriptions are per account (T-4).
 */
export async function recordSighting(
  c: WorkerContext<ApiEnv>,
  runner: RunnerRecord,
  logger: Logger,
  now: Date = new Date(),
): Promise<void> {
  const sighting = await sightingOf(c, now.toISOString());
  const outcome = await new RunnersRepo(c.env.DB).sight(runner.id, sighting, (alert) => ({
    accountId: runner.accountId,
    at: sighting.at,
    actorKind: 'runner',
    actor: runner.id,
    kind: 'runner.suspect',
    target: runner.id,
    details: { reason: alert, country: sighting.country, previousCountry: runner.lastSeenCountry },
    ipCountry: sighting.country,
  }));
  if (outcome.alert !== null) {
    logger.warn('runner marked suspect', { runnerId: runner.id, reason: outcome.alert });
  }
}

export function runnerIdentityOf(runner: RunnerRecord): RunnerIdentity {
  return {
    kind: 'runner',
    runnerId: runner.id,
    accountId: runner.accountId,
    allowedProjects: runner.allowedProjects,
    isolation: runner.isolation,
    capabilities: runner.capabilities,
  };
}

/** The 401/429 problem of a refusal; the log carries the reason, never the token. */
export function runnerRefusal(
  c: WorkerContext<ApiEnv>,
  logger: Logger,
  verification: Extract<RunnerVerification, { ok: false }>,
): Response {
  logger.warn('runner rejected', { reason: verification.refusal });
  if (verification.refusal === 'runner-rate-limited') {
    return problem(c, {
      type: 'rate-limited',
      title: 'Too Many Requests',
      status: 429,
      retryAfter: verification.retryAfter ?? 60,
    });
  }
  return problem(c, { type: verification.refusal, title: 'Unauthorized', status: 401 });
}
