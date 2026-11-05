import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import { projectNotFound } from '../projects/lookup';
import { policyActorOf, type PolicyActor } from './policy';
import { TRACKER_MATRIX, isTrackerMatrixRoute, matrixRefusal, type TrackerRoute } from './tracker-matrix';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by `trackerAccess` only, after the matrix admitted the request. */
    policyActor: PolicyActor;
  }
}

/**
 * The tracker's gate (#444), replacing `ownerOnlyMiddleware` on every tracker route: the identity's policy actor
 * (none: 403 `owner-only`, before anything is read), a job's project scope (another project: 404
 * `project-not-found`, the same answer as a slug that does not exist), then the route's row of `TRACKER_MATRIX`
 * (its 403). Handlers read the admitted actor with `policyActorOfContext`.
 */
export function trackerAccess(route: TrackerRoute): MiddlewareHandler<WorkerHonoEnv<ApiEnv>> {
  const rule = TRACKER_MATRIX[route];
  return async (c, next) => {
    const logger = c.get('logger');
    const identity = c.get('identity');
    const actor = policyActorOf(identity, c.env);
    if (actor === null) {
      logger.warn('tracker route refused', { type: 'owner-only', reason: identity.kind });
      return problem(c, {
        type: 'owner-only',
        title: 'Forbidden',
        status: 403,
        detail: 'Only the owner and the jobs of the project can use this route',
      });
    }
    if (actor.kind === 'job' && actor.projectSlug !== c.req.param('slug')) {
      logger.warn('tracker route refused', { type: 'project-not-found', reason: 'other-project' });
      return projectNotFound(c);
    }
    const refusal = matrixRefusal(rule, actor);
    if (refusal !== null) {
      const reason = actor.kind === 'owner' ? 'owner' : actor.role;
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
    await next();
    return;
  };
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
