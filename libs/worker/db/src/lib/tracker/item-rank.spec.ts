import { initialRankOf, planQueueMove, RANK_GAP, rankBetween, rebalancedRanks, type LaneRow } from './item-rank';

// #456: the sparse rank model — a new item at the end, swaps that spend no gap, First below the first, a rebalance
// only when a midpoint has no room.

const row = (id: number, rank: number, number = id): LaneRow => ({ id, number, rank });
const LANE: LaneRow[] = [row(1, 1024), row(2, 2048), row(3, 3072)];

describe('the rank model', () => {
  it('ranks a new item at number × gap: the end of every queue', () => {
    expect(initialRankOf(1)).toBe(RANK_GAP);
    expect(initialRankOf(412)).toBe(412 * RANK_GAP);
    expect(initialRankOf(413)).toBeGreaterThan(initialRankOf(412));
  });

  it('swaps ranks with the neighbour on Up and Down, spending no gap', () => {
    expect(planQueueMove(LANE, 2, 'up')).toEqual({
      kind: 'move',
      rank: 1024,
      neighbour: { id: 1, rankRead: 1024, rank: 2048 },
      rebalance: false,
    });
    expect(planQueueMove(LANE, 2, 'down')).toEqual({
      kind: 'move',
      rank: 3072,
      neighbour: { id: 3, rankRead: 3072, rank: 2048 },
      rebalance: false,
    });
  });

  it('puts First one gap below the first item, keeping max(rank) ≤ max(number) × gap', () => {
    expect(planQueueMove(LANE, 3, 'first')).toEqual({ kind: 'move', rank: 0, neighbour: null, rebalance: false });
    const below = planQueueMove([row(1, 0), row(2, 1024)], 2, 'first');
    expect(below).toMatchObject({ rank: -1024 });
  });

  it('is a no-op already first, already last or alone, and a lost race off the lane', () => {
    expect(planQueueMove(LANE, 1, 'first')).toEqual({ kind: 'noop' });
    expect(planQueueMove(LANE, 1, 'up')).toEqual({ kind: 'noop' });
    expect(planQueueMove(LANE, 3, 'down')).toEqual({ kind: 'noop' });
    expect(planQueueMove([row(7, 7168)], 7, 'down')).toEqual({ kind: 'noop' });
    expect(planQueueMove(LANE, 9, 'up')).toBeNull();
  });

  it('finds a midpoint while the gap has room and asks for a rebalance when it is exhausted', () => {
    expect(rankBetween(null, null)).toBe(RANK_GAP);
    expect(rankBetween(null, 1024)).toBe(0);
    expect(rankBetween(2048, null)).toBe(3072);
    expect(rankBetween(1024, 2048)).toBe(1536);
    expect(rankBetween(1024, 1026)).toBe(1025);
    expect(rankBetween(1024, 1025)).toBeNull();
  });

  it('renumbers a rebalance as row_number × gap in (rank, number) order', () => {
    const ranks = rebalancedRanks([row(3, 5), row(1, 5, 9), row(2, -1024)]);
    expect([...ranks.entries()]).toEqual([
      [2, 1024],
      [3, 2048],
      [1, 3072],
    ]);
  });
});
