import type { WorkerContext } from '@worker/core';
import type { TrackerActor, TrackerProject } from '@worker/db';
import type { ApiEnv } from '../env';
import {
  policyActorOfRequest,
  trackerActorFrom,
  trackerProjectOf,
  trackerWriteRefusal,
  type PolicyActorOf,
} from './context';
import { policyActorOf } from '../auth/policy';
import type { PolicyActor } from '../auth/policy';
import { trackerWriteOf, type TrackerWrite } from './idempotency';

export interface TrackerWriteContext {
  readonly project: TrackerProject;
  readonly actor: TrackerActor;
  /** What the transition table and the route matrix judge; `actor` is how it is recorded. */
  readonly policyActor: PolicyActor;
  readonly write: TrackerWrite;
}

/**
 * The checks every tracker write starts with, in this order: the project (404), the tracker gate (409
 * `tracker-not-cut-over`, before anything else is read), the actor from the identity and whether the route admits
 * it (`admit`, the route matrix), then the `Idempotency-Key` and the body (400).
 */
export async function trackerWriteContextOf(
  c: WorkerContext<ApiEnv>,
  actorOf: PolicyActorOf = policyActorOf,
  admit: (policyActor: PolicyActor) => Response | null = () => null,
): Promise<TrackerWriteContext | Response> {
  const project = await trackerProjectOf(c);
  if (project instanceof Response) {
    return project;
  }
  const refusal = trackerWriteRefusal(c, project);
  if (refusal !== null) {
    return refusal;
  }
  const policyActor = policyActorOfRequest(c, actorOf);
  if (policyActor instanceof Response) {
    return policyActor;
  }
  const refused = admit(policyActor);
  if (refused !== null) {
    return refused;
  }
  const write = await trackerWriteOf(c);
  return write instanceof Response
    ? write
    : { project, actor: trackerActorFrom(policyActor), policyActor, write };
}
