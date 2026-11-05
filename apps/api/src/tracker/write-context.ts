import type { WorkerContext } from '@worker/core';
import type { TrackerActor, TrackerProject } from '@worker/db';
import type { ApiEnv } from '../env';
import { trackerActorOf, trackerProjectOf, trackerWriteRefusal } from './context';
import { trackerWriteOf, type TrackerWrite } from './idempotency';

export interface TrackerWriteContext {
  readonly project: TrackerProject;
  readonly actor: TrackerActor;
  readonly write: TrackerWrite;
}

/**
 * The checks every tracker write starts with, in this order: the project (404), the tracker gate (409
 * `tracker-not-cut-over`, before anything else is read), the actor from the identity, then the `Idempotency-Key`
 * and the body (400).
 */
export async function trackerWriteContextOf(
  c: WorkerContext<ApiEnv>,
): Promise<TrackerWriteContext | Response> {
  const project = await trackerProjectOf(c);
  if (project instanceof Response) {
    return project;
  }
  const refusal = trackerWriteRefusal(c, project);
  if (refusal !== null) {
    return refusal;
  }
  const actor = trackerActorOf(c);
  if (actor instanceof Response) {
    return actor;
  }
  const write = await trackerWriteOf(c);
  return write instanceof Response ? write : { project, actor, write };
}
