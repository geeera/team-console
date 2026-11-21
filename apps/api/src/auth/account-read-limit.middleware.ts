import type { MiddlewareHandler } from 'hono';
import { problem, sha256Hex, type WorkerHonoEnv } from '@worker/core';
import { RateLimitsRepo, rateWindowOf, retryAfterOf } from '@worker/db';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';

/**
 * Reads of `/api/v1/accounts` and `/api/v1/accounts/:id/*` per identity per fixed minute (#879). Sized from the
 * console's heaviest legitimate use: the add-runner wizard polls its intent every 3 s (20 a minute) and then
 * `GET …/runners` every 5 s (12 a minute), and a Settings load reads about six account routes. 120 is six wizards'
 * worth, so several tabs and reloads fit; it bounds a scripted owner session at 2 D1 reads a second.
 */
export const ACCOUNT_READS_PER_WINDOW = 120;
export const ACCOUNT_READ_WINDOW_SECONDS = 60;

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * The bucket of an identity: the person, never the account, so membership of more accounts buys no more reads.
 * The Access owner before the 0018 link has no user id and is one person; free-form names are hashed so the key
 * stays within the column's 255 characters.
 */
export async function accountReadKeyOf(identity: Identity): Promise<string> {
  switch (identity.kind) {
    case 'user':
      return `account-read:user:${identity.userId ?? 'access-owner'}`;
    case 'service':
      return `account-read:service:${await sha256Hex(identity.commonName)}`;
    case 'job':
      return `account-read:job:${identity.jobId}`;
    case 'runner':
      return `account-read:runner:${identity.runnerId}`;
    case 'local':
    case 'enrolment':
      return `account-read:${identity.kind}`;
  }
}

/**
 * Mounted on the account paths after the auth seam and the scope inventory, so only a request that would reach a
 * route is counted. Writes are left to their own per-route limits; 429 `rate-limited` carries `Retry-After`, the
 * rest of the window.
 */
export const accountReadLimitMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  if (!READ_METHODS.has(c.req.method)) {
    await next();
    return;
  }
  const at = Date.now();
  const identity = c.get('identity');
  const hit = await new RateLimitsRepo(c.env.DB).hit(
    await accountReadKeyOf(identity),
    rateWindowOf(at, ACCOUNT_READ_WINDOW_SECONDS),
    ACCOUNT_READS_PER_WINDOW,
  );
  if (!hit.allowed) {
    // Once per bucket and window, so a flood is one line, not one per refusal; only the kind, never the bucket's id.
    if (hit.count === ACCOUNT_READS_PER_WINDOW + 1) {
      c.get('logger').warn('account reads rate limited', { identity: identity.kind });
    }
    return problem(c, {
      type: 'rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: `At most ${String(ACCOUNT_READS_PER_WINDOW)} account reads per minute`,
      retryAfter: retryAfterOf(at, ACCOUNT_READ_WINDOW_SECONDS),
    });
  }
  await next();
  return;
};
