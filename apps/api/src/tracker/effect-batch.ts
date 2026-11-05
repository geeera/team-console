import type { WorkerContext } from '@worker/core';
import {
  ItemsRepo,
  batchUnlessConflict,
  isAppendOnlyConflict,
  type ItemRecord,
  type TrackerActor,
} from '@worker/db';
import type { ApiEnv } from '../env';
import { itemChanged } from './context';
import type { ItemUpdatePlan } from './item-change';

/**
 * One batch: the item's effect (`plan`, under the version that was read) and the row's own `statements`. `false`
 * when the batch lost a race — the version moved on, or an append-only row (an ask, a comment) was answered,
 * withdrawn or reversed since it was read — so nothing at all was written.
 */
export async function writeWithItemEffect(
  db: D1Database,
  item: ItemRecord,
  plan: ItemUpdatePlan | null,
  actor: TrackerActor,
  at: string,
  statements: readonly D1PreparedStatement[],
): Promise<boolean> {
  if (plan === null) {
    return batchUnlessConflict(db, statements);
  }
  try {
    return await new ItemsRepo(db).update(
      item.id,
      item.version,
      plan.patch,
      plan.flags,
      actor,
      plan.events,
      at,
      [...statements],
    );
  } catch (error: unknown) {
    if (isAppendOnlyConflict(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Runs `attempt` (which re-reads what it judges) and, when its batch lost a race (`null`), once more; a second lost
 * race is 409 `item-changed`. Never applies an effect outside the batch.
 */
export async function withOneRetry(
  c: WorkerContext<ApiEnv>,
  attempt: (isRetry: boolean) => Promise<Response | null>,
): Promise<Response> {
  const first = await attempt(false);
  if (first !== null) {
    return first;
  }
  c.get('logger').info('tracker write retried', { reason: 'lost-race' });
  return (await attempt(true)) ?? itemChanged(c);
}
