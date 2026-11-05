import type { ItemStatus } from '@shared/contracts';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isOwnerIdentity } from './owner-only.middleware';

/**
 * Who may change what on a tracker item: the transition table of ADR 0006 "API and authorisation" (threat model
 * #408, R5), a table in code rather than checks spread over handlers. In Phase 1a only the owner reaches the tracker
 * routes (`ownerOnlyMiddleware`); the `job` actor is here so the owner-semantic rules are fixed and tested before the
 * job identity and the route matrix arrive with Phase 2 of #309. Imported text never reaches this table as an actor:
 * an imported row is data, it does not authorise a change.
 */

export type PolicyActor =
  | { readonly kind: 'owner' }
  /** `holdsItem`: the job's payload names this item (Phase 2 derives it; nothing in a body can claim it). */
  | { readonly kind: 'job'; readonly role: string; readonly holdsItem: boolean };

/** The parts of an item the table judges, before and after a change. */
export interface ItemPolicyState {
  readonly status: ItemStatus;
  readonly flags: readonly string[];
  readonly closed: boolean;
}

/** What else the change touches (title, body, kind, severity, tier, sprint): only the editing roles may. */
export interface ItemTransition {
  /** `null` for a new item. */
  readonly before: ItemPolicyState | null;
  readonly after: ItemPolicyState;
  readonly changesOtherFields: boolean;
}

export type TransitionRefusal = {
  readonly type: 'transition-owner-only' | 'transition-role';
  /** A stable reason for the log and the problem's `reason` extension. */
  readonly reason:
    | 'approve'
    | 'design-approved'
    | 'owner-flag'
    | 'close-demo'
    | 'workflow-change'
    | 'remove-guard-flag'
    | 'role-cannot-edit'
    | 'item-not-held';
};

/** Roles that create and edit items within the table (ADR 0006: `pm`, `architect`, `orchestrator`). */
const EDITING_ROLES: ReadonlySet<string> = new Set(['pm', 'architect', 'orchestrator']);
/** Roles that may only move the status of an item they hold. */
const STATUS_ONLY_ROLE = /^(dev(-[a-z]+)?|qa)$/;
/** Flags only the owner sets or clears; outside Phase 1a′'s decision effects, never a job. */
const OWNER_FLAG_PREFIX = 'owner:';
const DESIGN_APPROVED = 'design:approved';
const DEMO = 'team:demo';
const WORKFLOW_CHANGE = 'workflow-change';
/** Removing one of these needs `security` or `pm`, so a job cannot quietly unblock a release or a review. */
const GUARD_FLAGS: readonly string[] = ['release-blocker', 'security'];

function changedFlags(
  before: ItemPolicyState | null,
  after: ItemPolicyState,
): { added: string[]; removed: string[] } {
  const was = new Set(before?.flags ?? []);
  const is = new Set(after.flags);
  return {
    added: after.flags.filter((flag) => !was.has(flag)),
    removed: [...was].filter((flag) => !is.has(flag)),
  };
}

/** The owner-semantic part (R5): these happen only as the effect of an owner decision, never as a job's write. */
function ownerOnlyRefusal(transition: ItemTransition): TransitionRefusal | null {
  const { before, after } = transition;
  const { added, removed } = changedFlags(before, after);
  const touched = [...added, ...removed];
  // Approving is the owner's scope decision; a new item created as approved would be the same decision.
  if (after.status === 'approved' && (before === null || before.status === 'proposed')) {
    return { type: 'transition-owner-only', reason: 'approve' };
  }
  if (touched.includes(DESIGN_APPROVED)) {
    return { type: 'transition-owner-only', reason: 'design-approved' };
  }
  if (touched.some((flag) => flag.startsWith(OWNER_FLAG_PREFIX))) {
    return { type: 'transition-owner-only', reason: 'owner-flag' };
  }
  const isDemo = (before?.flags ?? []).includes(DEMO) || after.flags.includes(DEMO);
  if (isDemo && after.closed && !(before?.closed ?? false)) {
    return { type: 'transition-owner-only', reason: 'close-demo' };
  }
  return null;
}

function roleRefusal(role: string, holdsItem: boolean, transition: ItemTransition): TransitionRefusal | null {
  const { before, after } = transition;
  const { added, removed } = changedFlags(before, after);
  if ([...added, ...removed].includes(WORKFLOW_CHANGE) && role !== 'security') {
    return { type: 'transition-role', reason: 'workflow-change' };
  }
  if (removed.some((flag) => GUARD_FLAGS.includes(flag)) && role !== 'security' && role !== 'pm') {
    return { type: 'transition-role', reason: 'remove-guard-flag' };
  }
  if (EDITING_ROLES.has(role)) {
    return null;
  }
  const cannotEdit: TransitionRefusal = { type: 'transition-role', reason: 'role-cannot-edit' };
  if (before === null || transition.changesOtherFields) {
    return cannotEdit;
  }
  const changesFlags = added.length > 0 || removed.length > 0;
  const changesStatus = before.status !== after.status;
  if (role === 'security') {
    // Flags only (`security`, `release-blocker`, `workflow-change`, …): no status, no closing.
    return !changesStatus && before.closed === after.closed ? null : cannotEdit;
  }
  if (STATUS_ONLY_ROLE.test(role)) {
    // The status alone (`done` closes), of an item the job holds.
    if (changesFlags || (!changesStatus && before.closed !== after.closed)) {
      return cannotEdit;
    }
    return holdsItem ? null : { type: 'transition-role', reason: 'item-not-held' };
  }
  return cannotEdit;
}

/** Why `actor` may not make `transition`, or `null` when it may. The owner may make every change. */
export function transitionRefusal(actor: PolicyActor, transition: ItemTransition): TransitionRefusal | null {
  if (actor.kind === 'owner') {
    return null;
  }
  return ownerOnlyRefusal(transition) ?? roleRefusal(actor.role, actor.holdsItem, transition);
}

/**
 * The policy actor of an identity: the owner for the allowlist `ownerOnlyMiddleware` passes (the owner's Access
 * login, or the local bypass with `ENVIRONMENT=local` + `AUTH_MODE=local`). `null` for every other kind — the
 * service identity and any kind added later — so nothing acts on the tracker until it is mapped here on purpose.
 */
export function policyActorOf(
  identity: Identity,
  env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>,
): PolicyActor | null {
  return isOwnerIdentity(identity, env) ? { kind: 'owner' } : null;
}
