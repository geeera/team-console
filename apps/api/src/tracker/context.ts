import { itemNumberOfKey } from '@shared/contracts';
import { problem, type ProblemExtensionValue, type WorkerContext } from '@worker/core';
import {
  ItemsRepo,
  TrackerProjectsRepo,
  type ItemRecord,
  type TrackerActor,
  type TrackerProject,
} from '@worker/db';
import { policyActorOf, type TransitionRefusal } from '../auth/policy';
import type { ApiEnv } from '../env';
import { projectNotFound } from '../projects/lookup';

type Context = WorkerContext<ApiEnv>;

// The registry's lookup rule (projects/lookup.ts): a slug with `/`, `..` or an encoded slash never reaches D1.
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** The active project behind `:slug` with its tracker columns, or the 404. */
export async function trackerProjectOf(c: Context): Promise<TrackerProject | Response> {
  const slug = c.req.param('slug') ?? '';
  const project = SLUG_PATTERN.test(slug) ? await new TrackerProjectsRepo(c.env.DB).find(slug) : null;
  return project ?? projectNotFound(c);
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
 * Who the write is recorded as. Derived from the identity alone (ADR 0006 decision 4): no body member names an
 * author. The tracker routes are owner-only, so the service identity never gets here; it still gets a 403 if it does.
 */
export function trackerActorOf(c: Context): TrackerActor | Response {
  const actor = policyActorOf(c.get('identity'), c.env);
  if (actor === null) {
    return problem(c, { type: 'owner-only', title: 'Forbidden', status: 403 });
  }
  return { kind: actor.kind, name: 'owner', jobId: null };
}

export function transitionProblem(c: Context, refusal: TransitionRefusal): Response {
  c.get('logger').warn('tracker transition refused', { type: refusal.type, reason: refusal.reason });
  return problem(c, {
    type: refusal.type,
    title: 'Forbidden',
    status: 403,
    detail:
      refusal.type === 'transition-owner-only'
        ? 'Only an owner decision makes this change'
        : 'This role cannot make this change',
    extensions: { reason: refusal.reason },
  });
}

/** A 422 that names the request member to fix; the member's value is never echoed. */
export function invalid(
  c: Context,
  type: 'item-invalid' | 'sprint-invalid' | 'comment-invalid' | 'label-invalid' | 'query-invalid',
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
