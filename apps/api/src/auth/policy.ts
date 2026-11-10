import {
  isWorkableStatus,
  type AskCategory,
  type CommentKind,
  type DecisionCommand,
  type ItemStatus,
  type Section,
  type UpdateItemInput,
} from '@shared/contracts';
import type { ItemRecord } from '@worker/db';
import type { ApiEnv } from '../env';
import { planItemUpdate, type ItemUpdatePlan } from '../tracker/item-change';
import type { Identity } from './auth.types';
import { EDITING_ROLES, REVIEWER_ROLES, STATUS_ONLY_ROLES, type JobRole } from './job-roles';
import { isLocalBypass } from './local-bypass';
import { roleIn } from './scope';

/**
 * Who may change what on a tracker item: the transition table of ADR 0006 "API and authorisation" (threat model
 * #408, R5), a table in code rather than checks spread over handlers. Which identity reaches which tracker route is
 * the route matrix (`tracker-matrix.ts`); this table then judges the change itself. Imported text never reaches
 * this table as an actor: an imported row is data, it does not authorise a change.
 */

export type PolicyActor =
  /** An `owner` member of the project's account (ADR 0008 decision 3), or the environment's owner. */
  | { readonly kind: 'owner' }
  /**
   * A `member` of the project's account (#466): reads, `comment`s, `proposed` items and requests — never decisions,
   * asks' answers, approvals, sprints, labels or settings. `userId` is how a write would be recorded.
   */
  | { readonly kind: 'member'; readonly userId: string }
  /**
   * A job of one role in one project. `items`: the item numbers its payload names, the items it "holds"; `jobId`:
   * the job the token belongs to. All from the identity, never from a body.
   */
  | {
      readonly kind: 'job';
      readonly role: JobRole;
      readonly projectSlug: string;
      readonly jobId: string;
      readonly items: readonly number[];
    };

/** The parts of an item the table judges, before and after a change. */
export interface ItemPolicyState {
  readonly status: ItemStatus;
  readonly flags: readonly string[];
  readonly closed: boolean;
  /** The item carries the owner's recorded scope approval (`items.approved_at`, #452). */
  readonly approved: boolean;
}

/** What else the change touches: only the editing roles may, and the text only before the owner's approval. */
export interface ItemTransition {
  /** `null` for a new item. */
  readonly before: ItemPolicyState | null;
  readonly after: ItemPolicyState;
  /** The title or the body: the text the owner approves (#462, `edit-after-approval`). */
  readonly changesText: boolean;
  /** The kind, severity, tier or sprint: sizing and planning, which go on after the approval. */
  readonly changesPlanning: boolean;
  /** Any other field: no job may change it until it is classified (fail closed). */
  readonly changesUnclassified: boolean;
}

export type TransitionRefusal = {
  readonly type: 'transition-owner-only' | 'transition-role';
  /** A stable reason for the log and the problem's `reason` extension. */
  readonly reason:
    | 'approve'
    | 'edit-after-approval'
    | 'unclassified-field'
    | 'leave-proposed'
    | 'not-approved'
    | 'design-approved'
    | 'owner-flag'
    | 'close-demo'
    | 'demo-flag'
    | 'workflow-change'
    | 'remove-guard-flag'
    | 'role-cannot-edit'
    | 'item-not-held'
    | 'verdict-flag'
    | 'member-proposes-only';
};

/** Flags only the owner sets or clears; outside Phase 1a′'s decision effects, never a job. */
const OWNER_FLAG_PREFIX = 'owner:';
const DESIGN_APPROVED = 'design:approved';
const DESIGN_AWAITING = 'design:awaiting-approval';
const DEMO = 'team:demo';
const WORKFLOW_CHANGE = 'workflow-change';
/** Removing one of these needs `security` or `pm`, so a job cannot quietly unblock a release or a review. */
const GUARD_FLAGS: readonly string[] = ['release-blocker', 'security'];
/**
 * Flags that record a review's outcome (`slot-qa` sets them as the orchestrator). R2: a reviewer role never writes
 * state that reads as a verdict — its verdict is the signed row of Phase 2 — so it neither sets nor clears these.
 */
const VERDICT_FLAGS: readonly string[] = ['qa:changes-requested', 'review-failed', 'tier-up'];

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
  // Approving is the owner's scope decision (#452). A job never reaches `approved` from another status, and an
  // item leaves `proposed` (or is created past it) only that way, so no detour such as `proposed → blocked →
  // approved` skips it. Closing a proposed item as not planned or duplicate keeps its status, so a job may still do it.
  const wasStatus = before?.status ?? 'proposed';
  if (transition.changesUnclassified) {
    return { type: 'transition-owner-only', reason: 'unclassified-field' };
  }
  if (after.status === 'approved' && before?.status !== 'approved') {
    return { type: 'transition-owner-only', reason: 'approve' };
  }
  if (wasStatus === 'proposed' && after.status !== 'proposed') {
    return { type: 'transition-owner-only', reason: 'leave-proposed' };
  }
  // The approved text is frozen for jobs (#462): what the owner approved is what the team builds. Corrections are a
  // `note` comment or the owner's own edit; planning fields stay the editing roles'.
  if ((before?.approved ?? false) && transition.changesText) {
    return { type: 'transition-owner-only', reason: 'edit-after-approval' };
  }
  // The status alone does not prove an approval: the release decision closes a proposed demo item as `done`. Work
  // needs the recorded approval (`items.approved_at`); without it, a job may only take the item back to `proposed`.
  if (isWorkableStatus(after.status) && !(before?.approved ?? false)) {
    return { type: 'transition-owner-only', reason: 'not-approved' };
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
  // The flag marks the release record; dropped from a closed item, the item would look like any other closed one.
  if ((before?.closed ?? false) && removed.includes(DEMO)) {
    return { type: 'transition-owner-only', reason: 'demo-flag' };
  }
  return null;
}

function roleRefusal(role: JobRole, isHeld: boolean, transition: ItemTransition): TransitionRefusal | null {
  const { before, after } = transition;
  const { added, removed } = changedFlags(before, after);
  if ([...added, ...removed].includes(WORKFLOW_CHANGE) && role !== 'security') {
    return { type: 'transition-role', reason: 'workflow-change' };
  }
  if (removed.some((flag) => GUARD_FLAGS.includes(flag)) && role !== 'security' && role !== 'pm') {
    return { type: 'transition-role', reason: 'remove-guard-flag' };
  }
  if (REVIEWER_ROLES.has(role) && [...added, ...removed].some((flag) => VERDICT_FLAGS.includes(flag))) {
    return { type: 'transition-role', reason: 'verdict-flag' };
  }
  if (EDITING_ROLES.has(role)) {
    return null;
  }
  const cannotEdit: TransitionRefusal = { type: 'transition-role', reason: 'role-cannot-edit' };
  if (before === null || transition.changesText || transition.changesPlanning) {
    return cannotEdit;
  }
  const changesFlags = added.length > 0 || removed.length > 0;
  const changesStatus = before.status !== after.status;
  if (role === 'security') {
    // Flags only (`security`, `release-blocker`, `workflow-change`, …): no status, no closing.
    return !changesStatus && before.closed === after.closed ? null : cannotEdit;
  }
  if (STATUS_ONLY_ROLES.has(role)) {
    // The status alone (`done` closes), of an item the job holds.
    if (changesFlags || (!changesStatus && before.closed !== after.closed)) {
      return cannotEdit;
    }
    return isHeld ? null : { type: 'transition-role', reason: 'item-not-held' };
  }
  return cannotEdit;
}

/** Whether the job's payload names item `number` (threat model C2: "holds" is the payload, never a body member). */
export function holdsItem(actor: PolicyActor, number: number | null): boolean {
  return actor.kind === 'job' && number !== null && actor.items.includes(number);
}

/** A member proposes: a new item, which the owner-only part keeps at `proposed`; never an edit of an existing one. */
function memberRefusal(transition: ItemTransition): TransitionRefusal | null {
  return transition.before === null ? null : { type: 'transition-role', reason: 'member-proposes-only' };
}

/**
 * Why `actor` may not make `transition` on item `itemNumber` (`null` for a new item), or `null` when it may. The
 * owner may make every change.
 */
export function transitionRefusal(
  actor: PolicyActor,
  transition: ItemTransition,
  itemNumber: number | null,
): TransitionRefusal | null {
  if (actor.kind === 'owner') {
    return null;
  }
  const ownerOnly = ownerOnlyRefusal(transition);
  if (ownerOnly !== null) {
    return ownerOnly;
  }
  return actor.kind === 'member'
    ? memberRefusal(transition)
    : roleRefusal(actor.role, holdsItem(actor, itemNumber), transition);
}

export type CommentKindRefusal = { readonly type: 'comment-kind'; readonly reason: CommentKind };

/**
 * Which comment kinds an actor writes (ADR 0006 matrix): the owner and a member `comment` only — the owner's
 * decisions are `owner_decisions` rows; a job any kind, but a team `decision` not as `dev-light`.
 */
export function commentKindRefusal(actor: PolicyActor, kind: CommentKind): CommentKindRefusal | null {
  const isAllowed =
    actor.kind === 'job' ? kind !== 'decision' || actor.role !== 'dev-light' : kind === 'comment';
  return isAllowed ? null : { type: 'comment-kind', reason: kind };
}

/**
 * The policy actor of an identity **in the account of the project it addresses** (ADR 0008 "Identity, routes and
 * the matrix"): `owner` for an `owner` member of that account (the Access owner and the local bypass own the
 * `owner` account by construction, `scope.ts`), `member` for a `member`; a job for the `job` identity, and only
 * while the local bypass holds (#444) — its only minter today is the local stand-in, so a `job` that reached a
 * deployed Worker some other way still maps to nothing. `null` for every other case (the service identity, a user
 * outside the account, any kind added later), so nothing acts on the tracker until it is mapped here on purpose.
 */
export function policyActorOf(
  identity: Identity,
  env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>,
  accountId: string,
): PolicyActor | null {
  if (identity.kind === 'job') {
    if (identity.source !== 'token' && !isLocalBypass(env)) {
      return null;
    }
    const { role, projectSlug, jobId, items } = identity;
    return { kind: 'job', role, projectSlug, jobId, items };
  }
  switch (roleIn(identity, env, accountId)) {
    case 'owner':
      return { kind: 'owner' };
    case 'member':
      // A member is always a session user with a row; the Access owner is never a `member` of anything by construction.
      return identity.kind === 'user' && identity.userId !== null
        ? { kind: 'member', userId: identity.userId }
        : null;
    case null:
      return null;
  }
}

/**
 * What an owner decision does to its item (R5, ADR 0006 "API and authorisation"): the owner-semantic changes a job
 * can never make itself, applied by the decision route through `planItemUpdate` in the decision's own batch, so the
 * events and the version bump are the same code as a PATCH. `null`: the decision row and its `decided` event only.
 */
export function decisionEffectOf(
  section: Section,
  command: DecisionCommand,
  item: { readonly status: ItemStatus },
): UpdateItemInput | null {
  // The owner-only `proposed → approved`; an item already past it keeps its status.
  const approve: UpdateItemInput = item.status === 'proposed' ? { status: 'approved' } : {};
  switch (section) {
    case 'question':
      // `reject` changes nothing: the PM closes the item as not planned, which a job may do.
      return command === 'approve' && item.status === 'proposed' ? approve : null;
    case 'design':
      if (command === 'approve') {
        return { ...approve, addLabels: [DESIGN_APPROVED], removeLabels: [DESIGN_AWAITING] };
      }
      // The designer re-submits; the reason is the decision's text.
      return command === 'reject' ? { removeLabels: [DESIGN_AWAITING] } : null;
    case 'release':
      // The demo item closes on any release decision; the decision row is the release record (ADR 0006 amendment).
      return command === 'go' || command === 'no-go' || command === 'override' ? { status: 'done' } : null;
    case 'owner':
      return command === 'done' ? { removeLabels: ['needs:owner'] } : null;
    case 'local':
      return command === 'done' ? { removeLabels: ['needs:local'] } : null;
  }
}

/**
 * What a job's ask does to its item, as `backlog ask` does on GitHub: `owner:<category>` is set and any other
 * `owner:*` removed; the kind and `needs:owner` are left alone. The second R5 exception (ADR 0006 amendment): applied
 * only as the effect of an `asks` row in the ask's own batch, never through the job's PATCH. `null` when the item
 * already carries exactly that flag.
 */
export function askEffectOf(item: ItemRecord, category: AskCategory, at: string): ItemUpdatePlan | null {
  const flag = `${OWNER_FLAG_PREFIX}${category}`;
  const outcome = planItemUpdate(
    item,
    {
      addLabels: [flag],
      removeLabels: item.flags.filter((name) => name.startsWith(OWNER_FLAG_PREFIX) && name !== flag),
    },
    undefined,
    at,
  );
  return outcome.kind === 'change' ? outcome.plan : null;
}
