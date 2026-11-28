import type { Context, MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isLocalBypass } from './local-bypass';

/**
 * Whether `identity` is **the environment's owner**: the owner's Access login, or the local bypass while
 * `ENVIRONMENT=local` and `AUTH_MODE=local` both hold. An allowlist (#434), so the service identity, the `job`
 * identity (#444), a session user (#466 — the routes behind this act on the environment-wide owner connection and
 * devices, which T-4 binds per user; until then only the Access door reaches them, whatever account the session
 * user owns) and any kind added later are refused until a route opts it in.
 */
export function isOwnerIdentity(identity: Identity, env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>): boolean {
  switch (identity.kind) {
    case 'user':
      return identity.door === 'access';
    case 'local':
      return isLocalBypass(env);
    default:
      return false;
  }
}

/**
 * Routes that act for the owner's GitHub account — the connection routes (#59), push (#11), the team commands
 * (#114) and the batch approve (#220) — are for the owner only (the console's own tracker has its route matrix,
 * `trackerAccess`, #444): the dev/stage
 * CI service token passes `authMiddleware` but must not start, read or revoke the owner's connection (#85) nor write
 * as the owner (#62). The answer route is the one owner write the service identity may reach, and only on a fixture
 * issue (`service-write-gate.ts`). Only `isOwnerIdentity` passes; every other kind is a 403.
 */
export const ownerOnlyMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  if (!isOwnerIdentity(c.get('identity'), c.env)) {
    return ownerOnlyRefusal(c);
  }
  await next();
  return;
};

/**
 * For the owner-grade writes an account owner's session also reaches (the registry's rename and archive, #482),
 * where `ownerOnlyMiddleware` would be too strict. An allowlist like `isOwnerIdentity`: a user (any door) and the
 * owner pass, and the route's `projectOwnerRefusal` then judges the account role; the dev/stage service identity
 * (#372), a job and any later kind get 403 `owner-only` before the project is looked up.
 */
export const userOrOwnerMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  const identity = c.get('identity');
  if (identity.kind !== 'user' && !isOwnerIdentity(identity, c.env)) {
    return ownerOnlyRefusal(c);
  }
  await next();
  return;
};

/**
 * 403 `owner-only`, shared with `ownerOrServiceRefusal` (`../projects/lookup.ts`) so both routes' refusals stay one
 * shape: `detail` says which route; the default is this middleware's own text.
 */
export function ownerOnlyRefusal(
  c: Context<WorkerHonoEnv<ApiEnv>>,
  detail = 'Only the owner can use this route',
): Response {
  c.get('logger').warn('owner route refused', {
    reason: c.get('identity').kind,
    method: c.req.method,
    path: c.req.path,
  });
  return problem(c, {
    type: 'owner-only',
    title: 'Forbidden',
    status: 403,
    detail,
  });
}
