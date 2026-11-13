/**
 * Accounts are the tenant (ADR 0008 decisions 1, 3, 5 and 6; migration 0018): the vocabularies the migration's CHECK
 * constraints enforce, the entitlements seam and the read DTOs. No route serves these yet (T-2 does).
 */

/** Crockford base32, 26 characters: the shape of every `accounts.id` and `users.id`. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID.test(value);
}

/**
 * The owner's account and user rows, created by migration 0018 with these fixed ids (a migration cannot generate a
 * ULID). `accounts.slug = 'owner'` is reserved, so no one else can create it.
 */
export const OWNER_ACCOUNT_ID = '01M6YSNJ000000000000000001';
export const OWNER_ACCOUNT_SLUG = 'owner';
export const OWNER_USER_ID = '01M6YSNJ000000000000000002';

export const ACCOUNT_PLANS = ['free', 'team'] as const;
export type AccountPlan = (typeof ACCOUNT_PLANS)[number];
export const isAccountPlan = (value: unknown): value is AccountPlan =>
  (ACCOUNT_PLANS as readonly unknown[]).includes(value);

/** `owner` decides, `member` works (ADR 0008 owner decision 8); `admin` is "Not yet". */
export const MEMBER_ROLES = ['owner', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const isMemberRole = (value: unknown): value is MemberRole =>
  (MEMBER_ROLES as readonly unknown[]).includes(value);

export const IDENTITY_PROVIDERS = ['github', 'gitlab'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];
export const isIdentityProvider = (value: unknown): value is IdentityProvider =>
  (IDENTITY_PROVIDERS as readonly unknown[]).includes(value);

/** `audit_events.actor_kind` (decision 5). `operator` and `system` rows may have no account. */
export const AUDIT_ACTOR_KINDS = ['user', 'job', 'runner', 'system', 'operator'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];
export const isAuditActorKind = (value: unknown): value is AuditActorKind =>
  (AUDIT_ACTOR_KINDS as readonly unknown[]).includes(value);

/**
 * Every action decision 5 audits. The SQL only checks the shape of `kind` (a CHECK list would need a rebuild of an
 * append-only table to grow), so this list is the vocabulary and `AuditRepo` takes nothing else.
 */
export const AUDIT_EVENT_KINDS = [
  'account.created',
  'auth.signed-in',
  'auth.signed-out',
  'auth.identity-linked',
  'invite.created',
  'invite.accepted',
  'invite.revoked',
  'member.joined',
  'member.role-changed',
  'member.removed',
  'installation.linked',
  'installation.unlinked',
  'runner.enrolled',
  'runner.revoked',
  'runner.policy-changed',
  // 2-A (#467): the one-time code, allowed-projects changes and the detection rows of threat model C4.
  'enrolment-code.created',
  'runner.updated',
  'runner.suspect',
  // The owner's runner management (#492): a suspect mark cleared, a pending code withdrawn.
  'runner.suspect-cleared',
  'enrolment-code.withdrawn',
  // The runner's pause on a usage or rate limit (#571), and its lifting.
  'runner.paused',
  'runner.resumed',
  'job.finished',
  'job.cancelled',
  'team.paused',
  'team.resumed',
  'inference-key.set',
  'inference-key.rotated',
  'inference-key.deleted',
  'hosted.enabled',
  'hosted.disabled',
  'spend-cap.changed',
  'job.dispatched',
  'job.claimed',
  'cutover.switched',
  'cutover.rolled-back',
  'plan.changed',
  'entitlements.changed',
  // The owner's registry actions (T-2, #466).
  'project.created',
  'project.updated',
  'project.archived',
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];
export const isAuditEventKind = (value: unknown): value is AuditEventKind =>
  (AUDIT_EVENT_KINDS as readonly unknown[]).includes(value);

/** UTF-8 bytes of one audit row's serialized `details`, after redaction; `audit_events` CHECKs the same bound. */
export const AUDIT_DETAILS_MAX_BYTES = 4096;
export const AUDIT_PAGE_MAX = 100;

/** What an account may use (decision 6). Every limit check reads it through `entitlementsOf`, never the JSON. */
export interface AccountEntitlements {
  readonly maxProjects: number;
  readonly maxMembers: number;
  readonly hostedRunner: boolean;
  readonly maxConcurrency: number;
  readonly spendCapUsdMonth: number;
}

/**
 * Plan defaults. Placeholders until the owner prices the plans (decision 6); enforcement is T-5. `hostedRunner` is
 * false everywhere until hosted mode is approved (decision 9).
 */
export const PLAN_ENTITLEMENTS: Readonly<Record<AccountPlan, AccountEntitlements>> = {
  free: { maxProjects: 3, maxMembers: 5, hostedRunner: false, maxConcurrency: 1, spendCapUsdMonth: 0 },
  team: { maxProjects: 50, maxMembers: 25, hostedRunner: false, maxConcurrency: 3, spendCapUsdMonth: 0 },
};

/** The JSON keys of `accounts.entitlements` (snake_case, as the ADR names them) and their bounds. */
const OVERRIDE_RULES: Readonly<Record<string, (value: unknown) => boolean>> = {
  max_projects: (value) => isIntegerIn(value, 0, 1000),
  max_members: (value) => isIntegerIn(value, 1, 1000),
  hosted_runner: (value) => typeof value === 'boolean',
  max_concurrency: (value) => isIntegerIn(value, 0, 32),
  spend_cap_usd_month: (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000,
};

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An operator's override of the plan defaults: an object of known keys only, each within its bounds. */
export function isEntitlementsOverride(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, field]) => Object.hasOwn(OVERRIDE_RULES, key) && OVERRIDE_RULES[key]?.(field) === true,
    )
  );
}

/**
 * The one reader of an account's limits: the plan's defaults with the operator's override on top. Fails closed: an
 * unknown plan or an override that does not pass the guard yields the free tier, never something wider.
 */
export function entitlementsOf(account: {
  readonly plan: string;
  readonly entitlements: unknown;
}): AccountEntitlements {
  const override = account.entitlements;
  if (!isAccountPlan(account.plan) || !isEntitlementsOverride(override)) {
    return PLAN_ENTITLEMENTS.free;
  }
  const base = PLAN_ENTITLEMENTS[account.plan];
  const hosted = override['hosted_runner'];
  return {
    maxProjects: numberOr(override['max_projects'], base.maxProjects),
    maxMembers: numberOr(override['max_members'], base.maxMembers),
    hostedRunner: typeof hosted === 'boolean' ? hosted : base.hostedRunner,
    maxConcurrency: numberOr(override['max_concurrency'], base.maxConcurrency),
    spendCapUsdMonth: numberOr(override['spend_cap_usd_month'], base.spendCapUsdMonth),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** An account as its members see it (`GET /api/v1/accounts/:id/settings`, T-2). */
export interface AccountDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly plan: AccountPlan;
  readonly entitlements: AccountEntitlements;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  /** ISO 8601 UTC; a suspended account reads only and claims no jobs. */
  readonly suspendedAt: string | null;
}

export interface AccountMemberDto {
  readonly userId: string;
  readonly login: string;
  readonly avatarUrl: string | null;
  readonly role: MemberRole;
  /** ISO 8601 UTC. */
  readonly joinedAt: string;
}

/**
 * `GET /api/v1/accounts` (#464): the accounts the caller is a member of and its role in each, so the console can
 * address `/accounts/:id/*` without knowing an id up front. Never another account; no entitlements or plan here.
 */
export interface AccountMembershipDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: MemberRole;
}

export interface AccountMembershipListDto {
  readonly accounts: readonly AccountMembershipDto[];
}

export interface AuditEventDto {
  readonly id: number;
  /** ISO 8601 UTC. */
  readonly at: string;
  readonly actorKind: AuditActorKind;
  readonly actor: string;
  readonly kind: AuditEventKind;
  readonly target: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Newest first; `nextCursor` is the id to pass as `before` for the next page, `null` at the end. */
export interface AuditEventListDto {
  readonly events: readonly AuditEventDto[];
  readonly nextCursor: number | null;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isEntitlements(value: unknown): value is AccountEntitlements {
  return (
    isRecord(value) &&
    isIntegerIn(value['maxProjects'], 0, 1000) &&
    isIntegerIn(value['maxMembers'], 1, 1000) &&
    typeof value['hostedRunner'] === 'boolean' &&
    isIntegerIn(value['maxConcurrency'], 0, 32) &&
    typeof value['spendCapUsdMonth'] === 'number' &&
    Number.isFinite(value['spendCapUsdMonth']) &&
    value['spendCapUsdMonth'] >= 0
  );
}

/** Narrows an answer of the Worker; the client renders no account it did not check. */
export function isAccountDto(value: unknown): value is AccountDto {
  return (
    isRecord(value) &&
    isUlid(value['id']) &&
    typeof value['slug'] === 'string' &&
    typeof value['name'] === 'string' &&
    isAccountPlan(value['plan']) &&
    isEntitlements(value['entitlements']) &&
    isTime(value['createdAt']) &&
    (value['suspendedAt'] === null || isTime(value['suspendedAt']))
  );
}

export function isAccountMemberDto(value: unknown): value is AccountMemberDto {
  return (
    isRecord(value) &&
    isUlid(value['userId']) &&
    typeof value['login'] === 'string' &&
    (value['avatarUrl'] === null || typeof value['avatarUrl'] === 'string') &&
    isMemberRole(value['role']) &&
    isTime(value['joinedAt'])
  );
}

export function isAuditEventDto(value: unknown): value is AuditEventDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'number' &&
    Number.isInteger(value['id']) &&
    isTime(value['at']) &&
    isAuditActorKind(value['actorKind']) &&
    typeof value['actor'] === 'string' &&
    isAuditEventKind(value['kind']) &&
    (value['target'] === null || typeof value['target'] === 'string') &&
    isRecord(value['details'])
  );
}

export function isAuditEventListDto(value: unknown): value is AuditEventListDto {
  return (
    isRecord(value) &&
    Array.isArray(value['events']) &&
    value['events'].every(isAuditEventDto) &&
    (value['nextCursor'] === null ||
      (typeof value['nextCursor'] === 'number' && Number.isInteger(value['nextCursor'])))
  );
}

export function isAccountMembershipDto(value: unknown): value is AccountMembershipDto {
  return (
    isRecord(value) &&
    isUlid(value['id']) &&
    typeof value['slug'] === 'string' &&
    typeof value['name'] === 'string' &&
    isMemberRole(value['role'])
  );
}

export function isAccountMembershipListDto(value: unknown): value is AccountMembershipListDto {
  return isRecord(value) && Array.isArray(value['accounts']) && value['accounts'].every(isAccountMembershipDto);
}
