import { itemNumberOfKey } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerContext } from '@worker/core';
import {
  ItemsRepo,
  TrackerProjectsRepo,
  type ItemRecord,
  type TrackerActor,
  type TrackerProject,
} from '@worker/db';
import type { PolicyActor, TransitionRefusal } from '../auth/policy';
import { trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import { projectNotFound } from '../projects/lookup';

type Context = WorkerContext<ApiEnv>;

/**
 * The project `trackerAccess` admitted (inside the request's scope, #466), as its tracker columns. Re-read so a
 * cutover or archive between the gate and the handler is seen; the scope was judged by the gate on the same slug.
 */
export async function trackerProjectOf(c: Context): Promise<TrackerProject | Response> {
  const admitted = trackerProjectOfContext(c);
  const current = await new TrackerProjectsRepo(c.env.DB).find(admitted.slug);
  return current === null || current.accountId !== admitted.account_id ? projectNotFound(c) : current;
}

/** A project whose tracker is still GitHub Issues takes no tracker write (ADR 0006 decision 1). */
export function trackerWriteRefusal(c: Context, project: TrackerProject): Response | null {
  return project.tracker !== 'github' && project.keyPrefix !== null ? null : trackerNotCutOver(c);
}

export function trackerNotCutOver(c: Context): Response {
  return problem(c, {
    type: 'tracker-not-cut-over',
    title: 'The project still uses GitHub Issues',
    status: 409,
    detail:
      'Items, sprints, comments and labels are written here only once the project has moved to the console',
  });
}

/** The prefix items of the project are keyed by; a project still on GitHub has none, so its items read `#N`. */
export function keyPrefixOf(project: TrackerProject): string {
  return project.keyPrefix ?? '#';
}

/** The item `:key` names (`TC-310` or `310`) in the project, or the problem: 400 `item-key`, 404 `item-not-found`. */
export async function itemOf(c: Context, project: TrackerProject): Promise<ItemRecord | Response> {
  const number = itemNumberOfKey(c.req.param('key') ?? '', project.keyPrefix ?? '');
  if (number === null) {
    return problem(c, {
      type: 'item-key',
      title: 'Not an item key',
      status: 400,
      detail: 'An item is named by its key (TC-310) or its number (310)',
    });
  }
  const item =
    number === 'other-project' ? null : await new ItemsRepo(c.env.DB).findByNumber(project.slug, number);
  return item ?? problem(c, { type: 'item-not-found', title: 'Item not found', status: 404 });
}

/**
 * How a policy actor is recorded on a row: the owner as `owner`, a job by its role and job id. Derived from the
 * identity alone (ADR 0006 decision 4): no body member names an author.
 */
export function trackerActorFrom(actor: PolicyActor): TrackerActor {
  switch (actor.kind) {
    case 'owner':
      return { kind: 'owner', name: 'owner', jobId: null };
    case 'job':
      return { kind: 'job', name: actor.role, jobId: actor.jobId };
    case 'member':
      // The matrix admits no member write until the tables know a `user` actor (T-3); reaching here is a bug.
      throw new Error('a member write reached the tracker before the user actor kind exists');
  }
}

export function transitionProblem(c: Context, refusal: TransitionRefusal): Response {
  c.get('logger').warn('tracker transition refused', { type: refusal.type, reason: refusal.reason });
  return problem(c, {
    type: refusal.type,
    title: 'Forbidden',
    status: 403,
    detail:
      refusal.reason === 'edit-after-approval'
        ? 'The approved title and body are the owner’s to change; add a note comment instead'
        : refusal.type === 'transition-owner-only'
          ? 'Only an owner decision makes this change'
          : 'This role cannot make this change',
    extensions: { reason: refusal.reason },
  });
}

/** A 422 that names the request member to fix; the member's value is never echoed. */
export function invalid(
  c: Context,
  type:
    | 'item-invalid'
    | 'sprint-invalid'
    | 'comment-invalid'
    | 'label-invalid'
    | 'ask-invalid'
    | 'decision-invalid'
    | 'request-invalid'
    | 'decision-command'
    | 'query-invalid',
  field: string,
  detail: string,
): Response {
  const extensions: Record<string, ProblemExtensionValue> = { field };
  return problem(c, {
    type,
    title: 'Invalid request',
    status: type === 'query-invalid' ? 400 : 422,
    detail,
    extensions,
  });
}

export function itemClosed(c: Context): Response {
  return problem(c, {
    type: 'item-closed',
    title: 'The item is closed',
    status: 409,
    detail: 'Reopen the item first',
  });
}

export function itemChanged(c: Context): Response {
  return problem(c, {
    type: 'item-changed',
    title: 'The item changed while it was written',
    status: 409,
    detail: 'Read the item again and repeat the request with a new Idempotency-Key',
  });
}
