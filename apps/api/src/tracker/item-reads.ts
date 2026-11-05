import type { WorkerContext } from '@worker/core';
import type { ItemRecord, TrackerProject } from '@worker/db';
import type { ApiEnv } from '../env';
import { itemOf, policyActorOfRequest, trackerProjectOf, type PolicyActorOf } from './context';
import { pageOf, type Page } from './http';

export interface ItemRead {
  readonly project: TrackerProject;
  readonly item: ItemRecord;
  readonly page: Page;
}

/**
 * The checks of an item's list reads (asks, decisions, requests; #434): an actor first — the owner, or a job once
 * Phase 2 maps one; every other identity is a 403 before D1 is read — then the project (404), the item (400/404)
 * and the page (400). Reads need no cut-over: a project still on GitHub simply has no rows.
 */
export async function itemReadOf(
  c: WorkerContext<ApiEnv>,
  actorOf: PolicyActorOf,
): Promise<ItemRead | Response> {
  const actor = policyActorOfRequest(c, actorOf);
  if (actor instanceof Response) {
    return actor;
  }
  const project = await trackerProjectOf(c);
  if (project instanceof Response) {
    return project;
  }
  const item = await itemOf(c, project);
  if (item instanceof Response) {
    return item;
  }
  const page = pageOf(c);
  return page instanceof Response ? page : { project, item, page };
}
