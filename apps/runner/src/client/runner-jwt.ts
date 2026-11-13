import { randomUUID, sign, type KeyObject } from 'node:crypto';
import { RUNNER_JWT_MAX_AGE_SECONDS } from '@shared/contracts';

/**
 * The runner JWT (ADR 0008 "Customer runner authentication without Access", threat model C4 row 1): EdDSA over the
 * enrolled key, `sub` the runner id, `aud` the environment, `exp - iat` at most 300 s and a fresh `jti` per call —
 * the console consumes each `jti` once, so a token is minted per request and never cached or reused.
 */

/** Short of the console's 300 s ceiling, so a slow request is not refused for age (the console allows 30 s skew). */
export const RUNNER_JWT_LIFETIME_SECONDS = 120;

export interface RunnerJwtClaims {
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface MintRunnerJwtInput {
  readonly privateKey: KeyObject;
  readonly runnerId: string;
  readonly audience: string;
  readonly now: Date;
  readonly jti?: string;
  readonly lifetimeSeconds?: number;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export function mintRunnerJwt(input: MintRunnerJwtInput): string {
  const lifetime = input.lifetimeSeconds ?? RUNNER_JWT_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > RUNNER_JWT_MAX_AGE_SECONDS) {
    throw new RangeError(`a runner JWT lives 1 to ${String(RUNNER_JWT_MAX_AGE_SECONDS)} seconds`);
  }
  if (input.privateKey.asymmetricKeyType !== 'ed25519' || input.privateKey.type !== 'private') {
    throw new TypeError('a runner JWT is signed with the Ed25519 runner key');
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const claims: RunnerJwtClaims = {
    sub: input.runnerId,
    aud: input.audience,
    iat,
    exp: iat + lifetime,
    jti: input.jti ?? randomUUID(),
  };
  const signingInput = `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(signingInput), input.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}
