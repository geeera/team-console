import { OWNER_ACCOUNT_ID, type MemberRole } from '@shared/contracts';
import type { Membership } from '@worker/db';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isLocalBypass } from './local-bypass';

/**
 * What a request may reach (ADR 0008 decision 2, threat model C9): a `user` its memberships, a **job its own project
 * only** (never the account, R4), the dev/stage service identity the owner's account (the team's e2e perimeter), the
 * local bypass the owner's account as its owner. `none` is every other identity — nothing is reachable by default.
 * `projects/lookup.ts` is the one place that applies it to a slug; the list routes apply it through
 * `scopedProjectsOf`.
 */
export type Scope =
  | { readonly kind: 'accounts'; readonly accountIds: readonly string[] }
  | { readonly kind: 'project'; readonly slug: string }
  /** A runner: its `allowed_projects`, and only inside its own account (ADR 0008 decision 2, #467). */
  | { readonly kind: 'runner'; readonly accountId: string; readonly slugs: readonly string[] }
  | { readonly kind: 'none' };

/**
 * The owner's account is the Access owner's by construction: migration 0018 attached every existing row to it and
 * the Access door admits `OWNER_EMAIL` alone (ADR 0001 decision 7). This is the door, not an email comparison
 * against `users.email` (decision 3 forbids that for the GitHub link).
 */
export const ACCESS_OWNER_MEMBERSHIPS: readonly Membership[] = [
  { accountId: OWNER_ACCOUNT_ID, role: 'owner' },
];

/** The memberships an identity carries: a user's own, the local bypass the owner's, nothing for the rest. */
export function membershipsOf(
  identity: Identity,
  env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>,
): readonly Membership[] {
  switch (identity.kind) {
    case 'user':
      return identity.memberships;
    case 'local':
      return isLocalBypass(env) ? ACCESS_OWNER_MEMBERSHIPS : [];
    default:
      // The service identity, a job, and any kind added later: no membership until mapped here on purpose.
      return [];
  }
}

/** The identity's role in `accountId`, or `null` when it is no member (a 404 for anything behind the account). */
export function roleIn(
  identity: Identity,
  env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>,
  accountId: string,
): MemberRole | null {
  return membershipsOf(identity, env).find((membership) => membership.accountId === accountId)?.role ?? null;
}

export function scopeOf(identity: Identity, env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>): Scope {
  switch (identity.kind) {
    case 'user':
      return { kind: 'accounts', accountIds: identity.memberships.map((membership) => membership.accountId) };
    case 'local':
      return isLocalBypass(env) ? { kind: 'accounts', accountIds: [OWNER_ACCOUNT_ID] } : { kind: 'none' };
    case 'service':
      // The dev/stage CI token reads the team's own projects (#62); it is no member and maps to no policy actor.
      return { kind: 'accounts', accountIds: [OWNER_ACCOUNT_ID] };
    case 'job':
      return isLocalBypass(env) ? { kind: 'project', slug: identity.projectSlug } : { kind: 'none' };
    case 'runner':
      return { kind: 'runner', accountId: identity.accountId, slugs: identity.allowedProjects };
    case 'enrolment':
      return { kind: 'none' };
    default:
      // A kind the type does not know (forged past the seam in a test, or added later): nothing is in reach.
      return { kind: 'none' };
  }
}

/** Whether a project of `accountId` with `slug` is inside the scope. */
export function admits(
  scope: Scope,
  project: { readonly slug: string; readonly account_id: string },
): boolean {
  switch (scope.kind) {
    case 'accounts':
      return scope.accountIds.includes(project.account_id);
    case 'project':
      return scope.slug === project.slug;
    case 'runner':
      return scope.accountId === project.account_id && scope.slugs.includes(project.slug);
    case 'none':
      return false;
  }
}

/** The audit `actor` of an identity: the user's id, or a stable name for the doors that have no user row yet. */
export function auditActorOf(identity: Identity): {
  readonly kind: 'user' | 'job' | 'runner' | 'system';
  readonly actor: string;
} {
  switch (identity.kind) {
    case 'user':
      return { kind: 'user', actor: identity.userId ?? 'access-owner' };
    case 'local':
      return { kind: 'user', actor: 'local-owner' };
    case 'job':
      return { kind: 'job', actor: identity.jobId };
    case 'runner':
      return { kind: 'runner', actor: identity.runnerId };
    case 'enrolment':
      return { kind: 'system', actor: 'enrolment' };
    case 'service':
      return { kind: 'system', actor: identity.commonName };
    default:
      return { kind: 'system', actor: 'unknown' };
  }
}
