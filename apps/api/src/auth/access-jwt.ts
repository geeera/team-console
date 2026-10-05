import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AccessConfig } from './access-config';
import type { Identity } from './auth.types';

/** Access signs with RS256 only; pinning it rules out `alg: none` and HS256-with-the-public-key (threat model #8, row 1). */
const ALGORITHMS = ['RS256'];
/** jose checks `exp` only when present, so a token without it would never expire (row 2). */
const REQUIRED_CLAIMS = ['exp', 'iat', 'aud', 'iss'];
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * One key set per JWKS URL for the isolate's lifetime. jose caches the keys (10 min), refetches on an unknown
 * `kid` for rotation, and keeps its default 30 s cooldown so a flood of unknown `kid`s cannot hammer the endpoint.
 */
const keySets = new Map<string, JWTVerifyGetKey>();

function keySetFor(jwksUrl: URL): JWTVerifyGetKey {
  const cached = keySets.get(jwksUrl.href);
  if (cached !== undefined) {
    return cached;
  }
  const keySet = createRemoteJWKSet(jwksUrl);
  keySets.set(jwksUrl.href, keySet);
  return keySet;
}

export type AccessVerification =
  | { readonly ok: true; readonly payload: JWTPayload }
  /** `code` is jose's error code or the error's name — safe to log; the message and payload are not. */
  | { readonly ok: false; readonly code: string; readonly expected: boolean };

/**
 * Verifies signature, issuer, audience (a string or an array containing ours), `exp`/`nbf`/`iat`, and the
 * algorithm. Every failure, JWKS outages included, is a rejection: this never throws and never allows.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<AccessVerification> {
  try {
    const { payload } = await jwtVerify(token, keySetFor(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ALGORITHMS,
      requiredClaims: REQUIRED_CLAIMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return { ok: true, payload };
  } catch (error: unknown) {
    if (error instanceof errors.JOSEError) {
      return { ok: false, code: error.code, expected: true };
    }
    // A network error from the JWKS fetch lands here too; it still rejects, but is logged as unexpected.
    return { ok: false, code: error instanceof Error ? error.name : 'unknown', expected: false };
  }
}

export type IdentityDecision =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly reason: 'not-owner' | 'service-token-not-allowed' | 'no-subject' };

function stringClaim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Maps verified claims to an identity. A user token must carry the owner's email; a service token (Access puts
 * `common_name` and no `email` in it) must match the pinned client id, which is null outside dev/stage.
 */
export function identityOf(payload: JWTPayload, config: AccessConfig): IdentityDecision {
  const email = stringClaim(payload, 'email');
  if (email !== null) {
    return email.toLowerCase() === config.ownerEmail
      ? { ok: true, identity: { kind: 'user', email } }
      : { ok: false, reason: 'not-owner' };
  }
  const commonName = stringClaim(payload, 'common_name');
  if (commonName !== null) {
    return config.serviceTokenId !== null && commonName === config.serviceTokenId
      ? { ok: true, identity: { kind: 'service', commonName } }
      : { ok: false, reason: 'service-token-not-allowed' };
  }
  return { ok: false, reason: 'no-subject' };
}
