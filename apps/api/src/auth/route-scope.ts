import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import { matchRoute, routePatternsOf } from './route-pattern';
import { scopeOf } from './scope';

/**
 * The deny-by-default route inventory (ADR 0008 decision 2, threat model C9, #466): every route registered on the
 * Hono app declares how it is scoped, and `route-scope.spec.ts` walks `app.routes` and fails on one that does not.
 * `routeScopeMiddleware` refuses an unlisted route at run time too, so a route added without a row is unreachable
 * rather than open.
 *
 * - `project`: a `:slug` route; the project is reached only through `projects/lookup.ts`, which answers 404
 *   `project-not-found` outside the request's scope — the same answer as a slug that does not exist.
 * - `projects`: a listing over the scope's projects (`scopedProjectsOf`), never the environment's.
 * - `account`: `/api/v1/accounts/:id/*`, owner-of-account; a non-member gets 404 `account-not-found`.
 * - `own-user`: the user's own connection and devices; the owner's until T-4 binds them per user.
 * - `operator` / `runner`: `/admin/*` and `/runner/*` (T-5, 2-A); no identity satisfies them yet.
 * - `public`: no scope (`/healthz`).
 */
export type ScopeRule = 'project' | 'projects' | 'account' | 'own-user' | 'operator' | 'runner' | 'public';

const P = '/api/v1/projects/:slug';
const PROJECT = 'project' satisfies ScopeRule;

export const ROUTE_SCOPES = {
  'GET /api/v1/healthz': 'public',
  'GET /api/v1/projects': 'projects',
  'POST /api/v1/projects': 'projects',
  [`PATCH ${P}`]: PROJECT,
  [`POST ${P}/archive`]: PROJECT,
  [`GET ${P}/setup`]: PROJECT,
  [`GET ${P}/repository`]: PROJECT,
  [`GET ${P}/inbox`]: PROJECT,
  [`GET ${P}/questions`]: PROJECT,
  [`GET ${P}/sprint`]: PROJECT,
  [`GET ${P}/requests`]: PROJECT,
  [`GET ${P}/embed-origins`]: PROJECT,
  [`GET ${P}/sprint-freeze`]: PROJECT,
  [`GET ${P}/artifacts`]: PROJECT,
  [`GET ${P}/designs/:issue`]: PROJECT,
  [`GET ${P}/designs/:issue/:sha/file`]: PROJECT,
  'GET /api/v1/needs-you': 'projects',
  'GET /api/v1/overview': 'projects',
  [`POST ${P}/issues/:number/answer`]: PROJECT,
  [`POST ${P}/issues/:number/answer/lookup`]: PROJECT,
  [`POST ${P}/answers/batch`]: PROJECT,
  [`GET ${P}/team/status`]: PROJECT,
  [`POST ${P}/team/pause`]: PROJECT,
  [`POST ${P}/team/resume`]: PROJECT,
  [`POST ${P}/runs`]: PROJECT,
  [`PUT ${P}/notifications/snooze`]: PROJECT,
  [`DELETE ${P}/notifications/snooze`]: PROJECT,
  [`POST ${P}/sprint/demo-date`]: PROJECT,
  [`POST ${P}/sprint/next`]: PROJECT,
  [`GET ${P}/issues/:number/request`]: PROJECT,
  [`POST ${P}/issues/:number/request`]: PROJECT,
  // The console's own tracker (#444): `trackerAccess` applies the scope through the same lookup, then the matrix.
  [`GET ${P}/items`]: PROJECT,
  [`POST ${P}/items`]: PROJECT,
  [`GET ${P}/items/:key`]: PROJECT,
  [`PATCH ${P}/items/:key`]: PROJECT,
  [`GET ${P}/items/:key/events`]: PROJECT,
  [`POST ${P}/items/:key/events/scrub`]: PROJECT,
  [`GET ${P}/items/:key/comments`]: PROJECT,
  [`POST ${P}/items/:key/comments`]: PROJECT,
  [`GET ${P}/items/:key/asks`]: PROJECT,
  [`POST ${P}/items/:key/asks`]: PROJECT,
  [`GET ${P}/items/:key/decisions`]: PROJECT,
  [`POST ${P}/items/:key/decisions`]: PROJECT,
  [`GET ${P}/items/:key/requests`]: PROJECT,
  [`POST ${P}/items/:key/requests`]: PROJECT,
  [`POST ${P}/requests/:id/handled`]: PROJECT,
  [`GET ${P}/sprints`]: PROJECT,
  [`GET ${P}/sprints/:number`]: PROJECT,
  [`POST ${P}/sprints`]: PROJECT,
  [`PATCH ${P}/sprints/:number`]: PROJECT,
  [`GET ${P}/labels`]: PROJECT,
  [`POST ${P}/labels`]: PROJECT,
  // Pull requests (#463): the mirror in D1; `?fresh=1` is the account's (never a job's) and reads by `repo_id`.
  [`GET ${P}/prs`]: PROJECT,
  [`GET ${P}/prs/:number`]: PROJECT,
  // Which repositories the installation sees, with the scope's registrations only.
  'GET /api/v1/github/installation/repositories': 'projects',
  'POST /api/v1/github/connect': 'own-user',
  'GET /api/v1/github/callback': 'own-user',
  'GET /api/v1/github/connection': 'own-user',
  'DELETE /api/v1/github/connection': 'own-user',
  'GET /api/v1/push/config': 'own-user',
  'GET /api/v1/push/subscriptions': 'own-user',
  'PUT /api/v1/push/subscriptions': 'own-user',
  'DELETE /api/v1/push/subscriptions': 'own-user',
  'POST /api/v1/push/test': 'own-user',
  // The owner's map of the environment, with the scope's project slugs.
  'GET /api/v1/environment/status': 'projects',
  'GET /api/v1/accounts/:id/settings': 'account',
  'GET /api/v1/accounts/:id/members': 'account',
  'GET /api/v1/accounts/:id/audit': 'account',
} as const satisfies Readonly<Record<string, ScopeRule>>;

export type ScopedRoute = keyof typeof ROUTE_SCOPES;

const PATTERNS = routePatternsOf(Object.keys(ROUTE_SCOPES) as ScopedRoute[]);

/** The inventory row of `method path` (the router's own path), or `null` for a route the inventory does not list. */
export function routeScopeOf(method: string, path: string): { route: ScopedRoute; rule: ScopeRule } | null {
  const route = matchRoute(PATTERNS, method, path);
  return route === null ? null : { route, rule: ROUTE_SCOPES[route] };
}

/**
 * The chokepoint, mounted once on `/api/*` after the auth seam: a request to a route the inventory does not list
 * is answered 404 `not-found` (as a path that does not exist), and an identity whose scope cannot hold the rule's
 * kind is refused before the route's code runs. What a scoped route then reaches is `projects/lookup.ts`'s.
 */
export const routeScopeMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  const logger = c.get('logger');
  const scoped = routeScopeOf(c.req.method, c.req.path);
  if (scoped === null) {
    // Hono's own 404 for unknown paths is the same answer; a *registered* route landing here is a missing inventory
    // row, which route-scope.spec.ts fails on, so this is a safety net, not the gate.
    logger.warn('route refused', { reason: 'route-unscoped', method: c.req.method, path: c.req.path });
    return problem(c, { type: 'not-found', title: 'Not Found', status: 404 });
  }
  const identity = c.get('identity');
  const scope = scopeOf(identity, c.env);
  // The same log shape as `ownerOnlyMiddleware`: the identity's kind is the reason.
  const refuse = (detail: string): Response => {
    logger.warn('route refused', {
      reason: identity.kind,
      detail,
      rule: scoped.rule,
      method: c.req.method,
      path: c.req.path,
    });
    return problem(c, {
      type: 'owner-only',
      title: 'Forbidden',
      status: 403,
      detail: 'This route is not reachable by this identity',
    });
  };
  switch (scoped.rule) {
    case 'public':
      break;
    case 'project':
      if (scope.kind === 'none') {
        return refuse('no-scope');
      }
      break;
    case 'projects':
    case 'own-user':
    case 'account':
      // A job's scope is one project. The service identity passes here and is judged by the route's own gate
      // (`ownerOnlyMiddleware` on `own-user`, no membership on `account`), so its refusals keep their log lines.
      if (scope.kind !== 'accounts') {
        return refuse('no-account-scope');
      }
      break;
    case 'operator':
    case 'runner':
      return refuse('rule-not-served');
  }
  await next();
  return;
};
