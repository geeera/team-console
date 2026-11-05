import type { MiddlewareHandler } from 'hono';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import { projectNotFound } from '../projects/lookup';
import type { Identity } from './auth.types';
import { policyActorOf, type PolicyActor } from './policy';
import { TRACKER_MATRIX, matrixRefusal, type TrackerRoute } from './tracker-matrix';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by `trackerAccess` only, after the matrix admitted the request. */
    policyActor: PolicyActor;
  }
}

/** Maps an identity to its policy actor: `policyActorOf`, or the specs' stand-in for the job identity. */
export type PolicyActorOf = (identity: Identity, env: ApiEnv) => PolicyActor | null;

/**
 * The tracker's gate (#444), replacing `ownerOnlyMiddleware` on every tracker route: the identity's policy actor
 * (none: 403 `owner-only`, before anything is read), a job's project scope (another project: 404
 * `project-not-found`, the same answer as a slug that does not exist), then the route's row of `TRACKER_MATRIX`
 * (its 403). Handlers read the admitted actor with `policyActorOfContext`.
 */
export function trackerAccess(
  route: TrackerRoute,
  actorOf: PolicyActorOf = policyActorOf,
): MiddlewareHandler<WorkerHonoEnv<ApiEnv>> {
  const rule = TRACKER_MATRIX[route];
  return async (c, next) => {
    const logger = c.get('logger');
    const identity = c.get('identity');
    const actor = actorOf(identity, c.env);
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
