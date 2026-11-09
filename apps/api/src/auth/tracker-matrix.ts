import { DEVELOPER_ROLES, roleDecisions, type JobRole } from './job-roles';
import type { PolicyActor } from './policy';
import { matchRoute, routePatternsOf } from './route-pattern';

/**
 * The tracker's route matrix (ADR 0006 decision 11 and "API and authorisation", #444): who reaches each tracker
 * route, as one table the `trackerAccess` middleware enforces and `tracker-matrix.spec.ts` proves cell by cell.
 * What a route then does with the body is judged further down — item writes by the transition table
 * (`transitionRefusal`), comment kinds by `commentKindRefusal` — so a row here is the outer gate only.
 *
 * Every row admits a job of the route's own project only; a job of another project gets 404 `project-not-found`
 * (never 403, so a job cannot enumerate projects). An identity with no policy actor (the service) gets 403
 * `owner-only`. Phase 2 swaps the identity behind the `job` actor, not this table.
 */

export type TrackerRefusalType =
  | 'owner-only'
  | 'ask-role'
  | 'request-handled-role'
  | 'sprint-role'
  | 'member-role';

export interface TrackerRouteRule {
  readonly owner: boolean;
  /**
   * The `member` actor of the account (#466): reads, comments, proposed items and requests (ADR 0008). Until T-3
   * gives the tracker tables a `user` actor kind, a member's writes are refused here (`member-role`), so a
   * membership never records a write under another actor's name.
   */
  readonly member: boolean;
  /** Which job roles the route admits: every role decided (`roleDecisions`), so none falls through by default. */
  readonly job: Readonly<Record<JobRole, boolean>>;
  /** The 403 for an actor the row does not admit. */
  readonly refusal: TrackerRefusalType;
  readonly detail: string;
}

const ANY_ROLE = roleDecisions(() => true);
const NO_ROLE = roleDecisions(() => false);
const PM_ONLY = roleDecisions((role) => role === 'pm');

const READ: TrackerRouteRule = {
  owner: true,
  member: true,
  job: ANY_ROLE,
  refusal: 'owner-only',
  detail: 'Tracker reads are for the account’s members and the jobs of the project',
};

/** A write any role may attempt; the transition table or the comment kind then judges it. A member's turn is T-3. */
const WRITE = (detail: string): TrackerRouteRule => ({ ...READ, member: false, refusal: 'member-role', detail });

const OWNER_ONLY = (detail: string): TrackerRouteRule => ({
  owner: true,
  member: false,
  job: NO_ROLE,
  refusal: 'owner-only',
  detail,
});

const SPRINT_WRITE: TrackerRouteRule = {
  owner: true,
  member: false,
  job: PM_ONLY,
  refusal: 'sprint-role',
  detail: 'Sprints are planned by the owner and the PM',
};

const P = '/api/v1/projects/:slug';

export const TRACKER_MATRIX = {
  [`GET ${P}/items`]: READ,
  [`GET ${P}/items/:key`]: READ,
  [`GET ${P}/items/:key/events`]: READ,
  [`GET ${P}/items/:key/comments`]: READ,
  [`GET ${P}/items/:key/asks`]: READ,
  [`GET ${P}/items/:key/decisions`]: READ,
  [`GET ${P}/items/:key/requests`]: READ,
  [`GET ${P}/sprints`]: READ,
  [`GET ${P}/sprints/:number`]: READ,
  [`GET ${P}/labels`]: READ,
  // Any role reaches them; the transition table decides what it may change (R5) and refuses with its own 403s.
  [`POST ${P}/items`]: WRITE('Items are written within the transition table'),
  [`PATCH ${P}/items/:key`]: WRITE('Items are written within the transition table'),
  // Any role; which `kind` it may write is `commentKindRefusal`'s.
  [`POST ${P}/items/:key/comments`]: WRITE('Comments are written by the owner and the jobs'),
  [`POST ${P}/sprints`]: SPRINT_WRITE,
  [`PATCH ${P}/sprints/:number`]: SPRINT_WRITE,
  // The owner's custom flags; the builtin set is seeded at cut-over, so no job needs to add one.
  [`POST ${P}/labels`]: OWNER_ONLY('Labels are the owner’s'),
  [`POST ${P}/items/:key/asks`]: {
    owner: false,
    member: false,
    job: roleDecisions((role) => !DEVELOPER_ROLES.has(role)),
    refusal: 'ask-role',
    detail: 'Questions to the owner are asked by a team role other than dev',
  },
  // R5 and threat-model invariant 1: the owner's decisions and wishes are never a job's write.
  [`POST ${P}/items/:key/decisions`]: OWNER_ONLY('Only the owner decides; a decision is never a job write'),
  [`POST ${P}/items/:key/requests`]: OWNER_ONLY('A request to the PM is the owner’s own wish'),
  // #462: masking the audit trail is incident response; no job rewrites history, its own included.
  [`POST ${P}/items/:key/events/scrub`]: OWNER_ONLY('Only the owner scrubs an item’s history'),
  // ADR 0005: the PM answers a request, never silently; the record of who handled it is the job.
  [`POST ${P}/requests/:id/handled`]: {
    owner: false,
    member: false,
    job: PM_ONLY,
    refusal: 'request-handled-role',
    detail: 'Only the PM job answers a request',
  },
} as const satisfies Readonly<Record<string, TrackerRouteRule>>;

export type TrackerRoute = keyof typeof TRACKER_MATRIX;

/** The refusal of `actor` on a row, or `null` when the row admits it. Project scope is the middleware's. */
export function matrixRefusal(rule: TrackerRouteRule, actor: PolicyActor): TrackerRefusalType | null {
  const isAdmitted =
    actor.kind === 'owner' ? rule.owner : actor.kind === 'member' ? rule.member : rule.job[actor.role];
  return isAdmitted ? null : rule.refusal;
}

const MATRIX_PATTERNS = routePatternsOf(Object.keys(TRACKER_MATRIX) as TrackerRoute[]);

/**
 * Whether `method path` is a matrix route. The job identity is confined to these: every other `/api` route
 * refuses it before its own code runs (`jobScopeMiddleware`), so no GitHub-backed or registry route becomes a job's.
 *
 * `path` is `c.req.path`, the path the router matches: `createWorkerApp` routes with `strict: false`, which drops
 * one trailing slash before matching and before `c.req.path` is set. So this matches exactly, as the router does on
 * that path (#462): `/items/` arrives here as `/items` and is a matrix route; `/items//` arrives as `/items/`, which
 * no route matches, and is not.
 */
export function isTrackerMatrixRoute(method: string, path: string): boolean {
  return matchRoute(MATRIX_PATTERNS, method, path) !== null;
}
