import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isLocalBypass } from './local-bypass';

/**
 * Whether `identity` is the owner: the owner's Access login, or the local bypass while `ENVIRONMENT=local` and
 * `AUTH_MODE=local` both hold. An allowlist (#434), so the service identity and any kind added later (the Phase 2
 * `job` identity of #309) are refused until a route opts it in.
 */
export function isOwnerIdentity(identity: Identity, env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>): boolean {
  switch (identity.kind) {
    case 'user':
      return true;
    case 'local':
      return isLocalBypass(env);
    default:
      return false;
  }
}

/**
 * Routes that act for the owner's GitHub account — the connection routes (#59), push (#11), the team commands
 * (#114) and the batch approve (#220) — and the console's own tracker (#410) are for the owner only: the dev/stage
 * CI service token passes `authMiddleware` but must not start, read or revoke the owner's connection (#85) nor write
 * as the owner (#62). The answer route is the one owner write the service identity may reach, and only on a fixture
 * issue (`service-write-gate.ts`). Only `isOwnerIdentity` passes; every other kind is a 403.
 */
export const ownerOnlyMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  const identity = c.get('identity');
  if (!isOwnerIdentity(identity, c.env)) {
    c.get('logger').warn('owner route refused', {
      reason: identity.kind,
      method: c.req.method,
      path: c.req.path,
    });
    return problem(c, {
      type: 'owner-only',
      title: 'Forbidden',
      status: 403,
      detail: 'Only the owner can use this route',
    });
  }
  await next();
  return;
};
