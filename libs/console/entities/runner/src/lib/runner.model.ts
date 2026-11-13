import type { AccountMembershipDto, RunnerDto, RunnerPauseDto } from '@shared/contracts';

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
 * What holds a project's runs back (#571): every live runner allowed to serve it is paused. The pause that ends first
 * is the one that matters — that runner claims again then. `null` while any allowed runner is free, or none exists.
 */
export function projectPauseOf(runners: readonly RunnerDto[], slug: string): RunnerPauseDto | null {
  const serving = liveRunnersOf(runners).filter((runner) => runner.allowedProjects.includes(slug));
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
