import type { QueueMove } from '@shared/contracts';

/**
 * The queue order of a project's items (#456, migration 0029): one sparse integer `rank` per item, gap `RANK_GAP`,
 * unique within the project. A new item is ranked `number × RANK_GAP` (the end of every queue, since numbers only
 * grow); Up and Down swap ranks with the lane neighbour and spend no gap; First takes `min(rank) − RANK_GAP`. Only
 * a midpoint (the reserved `{ move: 'before', key }`) can run out of room, and then the whole project is renumbered
 * `row_number × RANK_GAP` in the same batch (`ItemsRepo.reorder` with `rebalance`). The invariant
 * `max(rank) ≤ max(number) × RANK_GAP` holds through all of it.
 */
export const RANK_GAP = 1024;

export function initialRankOf(number: number): number {
  return number * RANK_GAP;
}

/** One open item of a lane as the move reads it; a lane is ordered by (rank, number). */
export interface LaneRow {
  readonly id: number;
  readonly number: number;
  readonly rank: number;
}

/** What a queue move writes, decided on the lane as it was read; the batch checks it is still so. */
export type QueuePlan =
  /** Already first or last: nothing is written, no version is spent, no event. */
  | { readonly kind: 'noop' }
  | {
      readonly kind: 'move';
      /** The moved item's new rank (after the rebalance, when there is one). */
      readonly rank: number;
      /** The lane neighbour it swaps with (Up / Down), checked against the rank it was read at. */
      readonly neighbour: { readonly id: number; readonly rankRead: number; readonly rank: number } | null;
      /** Every item of the project is renumbered `row_number × RANK_GAP` first (a gap ran out). */
      readonly rebalance: boolean;
    };

/**
 * A rank strictly between `prev` and `next` (`null` = no item on that side), or `null` when the gap holds no
 * integer: the caller then rebalances the project (`rebalancedRanks`) and places against the new ranks.
 */
export function rankBetween(prev: number | null, next: number | null): number | null {
  if (prev === null && next === null) {
    return RANK_GAP;
  }
  if (prev === null) {
    return (next as number) - RANK_GAP;
  }
  if (next === null) {
    return prev + RANK_GAP;
  }
  return next - prev < 2 ? null : prev + Math.floor((next - prev) / 2);
}

/**
 * The plan of `move` for item `id` in its `lane` (open items of the same sprint and status, ordered). First on an
 * item already first, Up on the first and Down on the last are no-ops. A missing item (closed or moved meanwhile)
 * is the caller's lost race: `null`.
 */
export function planQueueMove(lane: readonly LaneRow[], id: number, move: QueueMove): QueuePlan | null {
  const index = lane.findIndex((row) => row.id === id);
  const item = lane[index];
  if (item === undefined) {
    return null;
  }
  if (move === 'first') {
    const first = lane[0];
    if (index === 0 || first === undefined) {
      return { kind: 'noop' };
    }
    // `rankBetween(null, …)` always has room: nothing is below the first item.
    return { kind: 'move', rank: rankBetween(null, first.rank) ?? first.rank - RANK_GAP, neighbour: null, rebalance: false };
  }
  const neighbour = lane[move === 'up' ? index - 1 : index + 1];
  if (neighbour === undefined) {
    return { kind: 'noop' };
  }
  return {
    kind: 'move',
    rank: neighbour.rank,
    neighbour: { id: neighbour.id, rankRead: neighbour.rank, rank: item.rank },
    rebalance: false,
  };
}

/**
 * Ranks after a rebalance: `row_number × RANK_GAP` over `rows` (a whole project) in (rank, number) order — the
 * numbering `ItemsRepo.reorder` applies in SQL, so a caller can place an item against it in the same batch.
 */
export function rebalancedRanks(rows: readonly LaneRow[]): ReadonlyMap<number, number> {
  const ordered = [...rows].sort((a, b) => a.rank - b.rank || a.number - b.number);
  return new Map(ordered.map((row, index) => [row.id, (index + 1) * RANK_GAP] as const));
}
