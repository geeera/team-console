import { getCookie } from 'hono/cookie';
import type { Logger, WorkerContext } from '@worker/core';
import { AccountsRepo, SessionsRepo, UsersRepo, sessionIdHashOf } from '@worker/db';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { ACCESS_OWNER_MEMBERSHIPS } from './scope';

/** The console's own session cookie (ADR 0008 decision 3): `__Host-`, so only this origin over https sets it. */
export const SESSION_COOKIE = '__Host-tc_session';
/** 256 random bits as base64url, exactly; anything else is not a session id and never reaches D1. */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * The identity of a live session cookie, or `null` when there is no cookie, it is malformed, expired, revoked or
 * its user is gone (#466: the member actor is resolved from the session; T-3 creates sessions). The memberships are
 * read here, per request, so a role change takes effect on the next request (threat model C9, session theft).
 */
export async function sessionIdentityOf(c: WorkerContext<ApiEnv>, logger: Logger): Promise<Identity | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw === undefined) {
    return null;
  }
  if (!SESSION_ID.test(raw)) {
    logger.warn('session refused', { reason: 'session-malformed' });
    return null;
  }
  const now = new Date().toISOString();
  const session = await new SessionsRepo(c.env.DB).findActive(await sessionIdHashOf(raw), now);
  if (session === null) {
    logger.warn('session refused', { reason: 'session-unknown' });
    return null;
  }
  const user = await new UsersRepo(c.env.DB).findById(session.userId);
  if (user === null) {
    logger.error('session refused', { reason: 'session-user-missing' });
    return null;
  }
  const memberships = await new AccountsRepo(c.env.DB).membershipsOf(user.id);
  return { kind: 'user', door: 'session', userId: user.id, memberships };
}

/**
 * The Access owner's user row and memberships: the row the explicit link of decision 3 named (`users.access_subject`
 * = the JWT `sub`), never one found by email. Without a link the owner still owns the `owner` account (decision 1's
 * backfill); the user id stays `null` until T-3 links it.
 */
export async function accessOwnerIdentityOf(
  c: WorkerContext<ApiEnv>,
  accessSubject: string | null,
): Promise<Identity> {
  const linked =
    accessSubject === null ? null : await new UsersRepo(c.env.DB).findByAccessSubject(accessSubject);
  if (linked === null) {
    return { kind: 'user', door: 'access', userId: null, memberships: ACCESS_OWNER_MEMBERSHIPS };
  }
  const own = await new AccountsRepo(c.env.DB).membershipsOf(linked.id);
  const memberships = [
    ...ACCESS_OWNER_MEMBERSHIPS,
    ...own.filter(
      (membership) => !ACCESS_OWNER_MEMBERSHIPS.some((m) => m.accountId === membership.accountId),
    ),
  ];
  return { kind: 'user', door: 'access', userId: linked.id, memberships };
}
