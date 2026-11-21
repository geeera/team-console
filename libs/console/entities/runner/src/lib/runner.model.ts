import { runnerScopeCovers, type AccountMembershipDto, type RunnerDto, type RunnerPauseDto } from '@shared/contracts';

/**
 * What the runner's row says first (#464): `revoked` is final; a `suspect` runner (threat model C4: a new country or
 * two pollers) is worth the owner's look before anything else; then a `paused` one (#571: a usage or rate limit,
 * until a time) — it stops polling meanwhile, so "offline" would mislead; otherwise presence by `last_seen_at`.
 */
export type RunnerPresence = 'revoked' | 'suspect' | 'paused' | 'online' | 'offline' | 'never-seen';

export function runnerPresenceOf(runner: RunnerDto): RunnerPresence {
  if (runner.revokedAt !== null) {
    return 'revoked';
  }
  if (runner.suspect !== null) {
    return 'suspect';
  }
  if (runner.pause !== null) {
    return 'paused';
  }
  if (runner.lastSeenAt === null) {
    return 'never-seen';
  }
  return runner.online ? 'online' : 'offline';
}

/** The runners a policy may name: the API refuses a revoked one (422 `runner-policy-invalid`). */
export function liveRunnersOf(runners: readonly RunnerDto[]): readonly RunnerDto[] {
  return runners.filter((runner) => runner.revokedAt === null);
}

/**
 * What holds a project's runs back (#571): every live runner whose scope covers it (#775: `all`, or the slug in its
 * list) is paused. The pause that ends first is the one that matters — that runner claims again then. `null` while
 * any such runner is free, or none exists.
 */
export function projectPauseOf(runners: readonly RunnerDto[], slug: string): RunnerPauseDto | null {
  const serving = liveRunnersOf(runners).filter((runner) => runnerScopeCovers(runner, slug));
  let first: RunnerPauseDto | null = null;
  for (const runner of serving) {
    if (runner.pause === null) {
      return null;
    }
    if (first === null || Date.parse(runner.pause.until) < Date.parse(first.until)) {
      first = runner.pause;
    }
  }
  return first;
}

/**
 * The runner owner decision D3 holds back from `slug` (#775), for the owner's `other-owner-subscription` copy: a live
 * machine runner under `all` that may sign in with a Claude subscription (it declares `subscription`, or nothing) yet
 * does not serve the project. The caller's own such runner first, since that one the caller can fix by hand. `null`
 * when no runner the caller reads fits, and the view falls back to the generic «no runner» copy.
 */
export function d3RunnerOf(runners: readonly RunnerDto[], slug: string): RunnerDto | null {
  const held = liveRunnersOf(runners).filter(
    (runner) =>
      runner.projectScope === 'all' &&
      !runner.hosted &&
      runner.isolation !== 'actions-ephemeral' &&
      (runner.capabilities.accessSources === undefined || runner.capabilities.accessSources.includes('subscription')) &&
      !runner.servedProjects.some((project) => project.slug === slug),
  );
  return held.find((runner) => runner.enrolledByYou) ?? held[0] ?? null;
}

/** Live runners first, then revoked ones; inside each, the order the Worker listed them in (enrolment). */
export function runnersInDisplayOrder(runners: readonly RunnerDto[]): readonly RunnerDto[] {
  return [...liveRunnersOf(runners), ...runners.filter((runner) => runner.revokedAt !== null)];
}

/**
 * The account Settings › Runners manages: the first one the caller owns. `member` when the caller only belongs to
 * accounts as a member (the routes would answer 403 `account-owner-only`), `none` when it belongs to none.
 */
export type ManagedAccount =
  | { readonly kind: 'owner'; readonly account: AccountMembershipDto }
  | { readonly kind: 'member' }
  | { readonly kind: 'none' };

export function managedAccountOf(accounts: readonly AccountMembershipDto[]): ManagedAccount {
  const owned = accounts.find((account) => account.role === 'owner');
  if (owned !== undefined) {
    return { kind: 'owner', account: owned };
  }
  return accounts.length > 0 ? { kind: 'member' } : { kind: 'none' };
}

/**
 * The caller's role in a project's own account. With the project's `accountId` (#870, `ProjectDto`) it is that
 * account's role in `GET /accounts`, or `unknown` when the caller is not listed there. Without one (a DTO built
 * elsewhere) the role is known only when every account gives the same one; with owner and member roles mixed it is
 * `unknown`, and owner-only surfaces stay hidden rather than show a member a door that answers 403.
 */
export type ProjectAccountRole = 'owner' | 'member' | 'unknown';

export function projectAccountRoleOf(
  accounts: readonly AccountMembershipDto[],
  accountId?: string,
): ProjectAccountRole {
  if (accountId !== undefined) {
    const role = accounts.find((account) => account.id === accountId)?.role;
    return role === undefined ? 'unknown' : role === 'owner' ? 'owner' : 'member';
  }
  const [first] = accounts;
  if (first === undefined) {
    return 'unknown';
  }
  const role = first.role;
  if (!accounts.every((account) => account.role === role)) {
    return 'unknown';
  }
  return role === 'owner' ? 'owner' : 'member';
}

/** A runner's name on one line, as the Worker stores it (`checkCreateEnrolmentCodeInput` trims). */
export function runnerNameOf(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
