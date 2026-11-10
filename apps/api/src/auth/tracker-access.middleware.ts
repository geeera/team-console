import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import type { ProjectRow } from '@worker/db';
import type { ApiEnv } from '../env';
import { findProject, projectNotFound } from '../projects/lookup';
import { policyActorOf, type PolicyActor } from './policy';
import { isLocalBypass } from './local-bypass';
import { TRACKER_MATRIX, isTrackerMatrixRoute, matrixRefusal, type TrackerRoute } from './tracker-matrix';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by `trackerAccess` only, after the matrix admitted the request. */
    policyActor: PolicyActor;
    /** The scoped project row `trackerAccess` admitted, so the handler reads it once. */
    trackerProject: ProjectRow;
  }
}

function ownerOnly(c: Parameters<MiddlewareHandler<WorkerHonoEnv<ApiEnv>>>[0], reason: string): Response {
  c.get('logger').warn('tracker route refused', { type: 'owner-only', reason });
  return problem(c, {
    type: 'owner-only',
    title: 'Forbidden',
    status: 403,
    detail: 'Only the account’s members and the jobs of the project can use this route',
  });
}

/**
 * The tracker's gate (#444, #466), replacing `ownerOnlyMiddleware` on every tracker route, in this order: an
 * identity that can act on no account at all (the service identity, a job off the bypass: 403 `owner-only`, before
 * anything is read); the project inside the request's scope (`projects/lookup.ts` — a job's other project, a user's
 * other account and a slug that does not exist are one 404 `project-not-found`); the identity's policy actor in
 * the project's account (none: 403 `owner-only`); then the route's row of `TRACKER_MATRIX` (its 403). Handlers
 * read the admitted actor with `policyActorOfContext` and the project with `trackerProjectOfContext`.
 */
export function trackerAccess(route: TrackerRoute): MiddlewareHandler<WorkerHonoEnv<ApiEnv>> {
  const rule = TRACKER_MATRIX[route];
  return async (c, next) => {
    const logger = c.get('logger');
    const identity = c.get('identity');
    if (
      identity.kind === 'service' ||
      (identity.kind === 'job' && identity.source !== 'token' && !isLocalBypass(c.env))
    ) {
      return ownerOnly(c, identity.kind);
    }
    const project = await findProject(c, c.req.param('slug') ?? '');
    if (project === null) {
      return projectNotFound(c);
    }
    const actor = policyActorOf(identity, c.env, project.account_id);
    if (actor === null) {
      return ownerOnly(c, identity.kind);
    }
    const refusal = matrixRefusal(rule, actor);
    if (refusal !== null) {
      const reason = actor.kind === 'job' ? actor.role : actor.kind;
      logger.warn('tracker route refused', { type: refusal, reason });
      return problem(c, {
        type: refusal,
        title: 'Forbidden',
        status: 403,
        detail: rule.detail,
        extensions: { reason },
      });
    }
    c.set('policyActor', actor);
    c.set('trackerProject', project);
    await next();
    return;
  };
}

/** The scoped project `trackerAccess` admitted; a handler mounted without it fails loudly, never open. */
export function trackerProjectOfContext(c: WorkerContext<ApiEnv>): ProjectRow {
  const project = c.get('trackerProject') as ProjectRow | undefined;
  if (project === undefined) {
    throw new Error('tracker handler reached without trackerAccess');
  }
  return project;
}

/** The actor `trackerAccess` admitted. A handler mounted without it is a bug, so it fails loudly, never open. */
export function policyActorOfContext(c: WorkerContext<ApiEnv>): PolicyActor {
  const actor = c.get('policyActor') as PolicyActor | undefined;
  if (actor === undefined) {
    throw new Error('tracker handler reached without trackerAccess');
  }
  return actor;
}

/**
 * Confines the `job` identity to the matrix routes (#444): mounted once on `/api/*` after the auth seam, it refuses a
 * job on every other route (403 `owner-only`) before that route's code runs — the GitHub-backed reads, the
 * registry, the owner's answer and connection routes were written for the owner and the service and judge
 * neither the job's role nor its project.
 */
export const jobScopeMiddleware: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = async (c, next) => {
  if (c.get('identity').kind === 'job' && !isTrackerMatrixRoute(c.req.method, c.req.path)) {
    c.get('logger').warn('job refused off the tracker', { method: c.req.method, path: c.req.path });
    return problem(c, {
      type: 'owner-only',
      title: 'Forbidden',
      status: 403,
      detail: 'A job reaches only the tracker routes',
    });
  }
  await next();
  return;
};
