import type { WorkerContext } from '@worker/core';
import type { ItemRecord, TrackerProject } from '@worker/db';
import type { ApiEnv } from '../env';
import { itemOf, trackerProjectOf } from './context';
import { pageOf, type Page } from './http';

export interface ItemRead {
  readonly project: TrackerProject;
  readonly item: ItemRecord;
  readonly page: Page;
}

/**
 * The checks of an item's list reads (asks, decisions, requests; #434), after `trackerAccess` admitted the actor:
 * the project (404), the item (400/404) and the page (400). Reads need no cut-over: a project still on GitHub simply
 * has no rows.
 */
export async function itemReadOf(c: WorkerContext<ApiEnv>): Promise<ItemRead | Response> {
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
