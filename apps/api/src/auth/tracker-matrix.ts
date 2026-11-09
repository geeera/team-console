import { DEVELOPER_ROLES, roleDecisions, type JobRole } from './job-roles';
import type { PolicyActor } from './policy';

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

export type TrackerRefusalType = 'owner-only' | 'ask-role' | 'request-handled-role' | 'sprint-role';

export interface TrackerRouteRule {
  readonly owner: boolean;
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
  job: ANY_ROLE,
  refusal: 'owner-only',
  detail: 'Tracker reads are for the owner and the jobs of the project',
};

const OWNER_ONLY = (detail: string): TrackerRouteRule => ({
  owner: true,
  job: NO_ROLE,
  refusal: 'owner-only',
  detail,
});

const SPRINT_WRITE: TrackerRouteRule = {
  owner: true,
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
  // #463: the VCS mirror; `?fresh=1` reads GitHub with the read-only installation token, writes only `pull_requests`.
  [`GET ${P}/prs`]: READ,
  [`GET ${P}/prs/:number`]: READ,
  // Any role reaches them; the transition table decides what it may change (R5) and refuses with its own 403s.
  [`POST ${P}/items`]: { ...READ, detail: 'Items are written within the transition table' },
  [`PATCH ${P}/items/:key`]: { ...READ, detail: 'Items are written within the transition table' },
  // Any role; which `kind` it may write is `commentKindRefusal`'s.
  [`POST ${P}/items/:key/comments`]: { ...READ, detail: 'Comments are written by the owner and the jobs' },
  [`POST ${P}/sprints`]: SPRINT_WRITE,
  [`PATCH ${P}/sprints/:number`]: SPRINT_WRITE,
  // The owner's custom flags; the builtin set is seeded at cut-over, so no job needs to add one.
  [`POST ${P}/labels`]: OWNER_ONLY('Labels are the owner’s'),
  [`POST ${P}/items/:key/asks`]: {
    owner: false,
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
    job: PM_ONLY,
    refusal: 'request-handled-role',
    detail: 'Only the PM job answers a request',
  },
} as const satisfies Readonly<Record<string, TrackerRouteRule>>;

export type TrackerRoute = keyof typeof TRACKER_MATRIX;

/** The refusal of `actor` on a row, or `null` when the row admits it. Project scope is the middleware's. */
export function matrixRefusal(rule: TrackerRouteRule, actor: PolicyActor): TrackerRefusalType | null {
  const isAdmitted = actor.kind === 'owner' ? rule.owner : rule.job[actor.role];
  return isAdmitted ? null : rule.refusal;
}

const PARAM = /:[a-z]+/g;

const MATRIX_PATTERNS: readonly { method: string; path: RegExp }[] = Object.keys(TRACKER_MATRIX).map(
  (route) => {
    const [method = '', pattern = ''] = route.split(' ');
    // Route params never match `/`. No optional trailing slash: the path judged is the router's own (below).
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(PARAM, '[^/]+');
    return { method, path: new RegExp(`^${source}$`) };
  },
);

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
  return MATRIX_PATTERNS.some((pattern) => pattern.method === method && pattern.path.test(path));
}
