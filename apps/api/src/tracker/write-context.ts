import type { WorkerContext } from '@worker/core';
import type { TrackerActor, TrackerProject } from '@worker/db';
import type { PolicyActor } from '../auth/policy';
import { policyActorOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import { trackerActorFrom, trackerProjectOf, trackerWriteRefusal } from './context';
import { trackerWriteOf, type TrackerWrite } from './idempotency';

export interface TrackerWriteContext {
  readonly project: TrackerProject;
  readonly actor: TrackerActor;
  /** What the transition table judges; `actor` is how it is recorded. */
  readonly policyActor: PolicyActor;
  readonly write: TrackerWrite;
}

/**
 * The checks every tracker write starts with, after `trackerAccess` admitted the actor (the route matrix), in this
 * order: the project (404), the tracker gate (409 `tracker-not-cut-over`, before anything else is read), then the
 * `Idempotency-Key` and the body (400).
 */
export async function trackerWriteContextOf(
  c: WorkerContext<ApiEnv>,
): Promise<TrackerWriteContext | Response> {
  const policyActor = policyActorOfContext(c);
  const project = await trackerProjectOf(c);
  if (project instanceof Response) {
    return project;
  }
  const refusal = trackerWriteRefusal(c, project);
  if (refusal !== null) {
    return refusal;
  }
  const write = await trackerWriteOf(c);
  return write instanceof Response
    ? write
    : { project, actor: trackerActorFrom(policyActor), policyActor, write };
}
