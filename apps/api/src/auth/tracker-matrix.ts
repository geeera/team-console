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
  | 'member-role'
  | 'pr-link-role';

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
/** #445: who opens pull requests in the plugin (`slot-dev`), and the orchestrator that runs the slots. */
const PR_LINKERS = roleDecisions((role) => DEVELOPER_ROLES.has(role) || role === 'orchestrator');

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
  // #445: the project-wide feeds of the plugin (`backlog reversals`, `backlog requests`). The requests row is the
  // `?state=` form only; the same path without it is the owner's GitHub list (#219), which refuses a job itself.
  [`GET ${P}/decisions`]: READ,
  [`GET ${P}/requests`]: READ,
  [`GET ${P}/sprints`]: READ,
  [`GET ${P}/sprints/:number`]: READ,
  [`GET ${P}/labels`]: READ,
  // #463: the VCS mirror; `?fresh=1` reads GitHub with the read-only installation token, writes only `pull_requests`.
  [`GET ${P}/prs`]: READ,
  [`GET ${P}/prs/:number`]: READ,
  // #467: the queue and its run log; a job reads its own project's (R4), the owner enqueues (Run now).
  [`GET ${P}/jobs`]: READ,
  [`GET ${P}/jobs/:id`]: READ,
  [`GET ${P}/jobs/:id/events`]: READ,
  [`GET ${P}/runner-policy`]: READ,
  [`POST ${P}/jobs`]: OWNER_ONLY('Run now is the owner’s'),
  [`PUT ${P}/runner-policy`]: OWNER_ONLY('Placement is the owner’s'),
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
  // #445: `backlog link-pr`; a developer links only an item it holds (`item-not-held`, judged by the route).
  [`POST ${P}/items/:key/pr-links`]: {
    owner: false,
    member: false,
    job: PR_LINKERS,
    refusal: 'pr-link-role',
    detail: 'A pull request is linked by the developer who opened it or by the orchestrator',
  },
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

/**
 * The read models a job of the project reads besides the matrix (#445, architect note on #436 §5 item 6): the
 * plugin's `inbox show`, `digest` and board. Their handlers reach the project through `projects/lookup.ts` with the
 * request's scope, so a job sees its own project only (another is 404 `project-not-found`); every role reads them.
 * The identity is not a policy actor there: these routes write nothing.
 */
export const JOB_READ_MODEL_ROUTES = [`GET ${P}/inbox`, `GET ${P}/questions`, `GET ${P}/sprint`] as const;

const READ_MODEL_PATTERNS = routePatternsOf([...JOB_READ_MODEL_ROUTES]);

/** Whether a job identity may reach `method path` at all: a matrix route or one of the job's read models. */
export function isJobRoute(method: string, path: string): boolean {
  return isTrackerMatrixRoute(method, path) || matchRoute(READ_MODEL_PATTERNS, method, path) !== null;
}
