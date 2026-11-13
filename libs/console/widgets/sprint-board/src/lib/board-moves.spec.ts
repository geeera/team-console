import { itemFixture } from '@console/entities/item';
import type { ItemDto, ItemSummaryDto } from '@shared/contracts';
import { placedInLane } from './board-moves';

// #456: after a reorder the section shows the lane as the server answered it, without a reload.

const task = (number: number, overrides: Partial<ItemDto> = {}): ItemDto =>
  itemFixture({ number, key: `TC-${String(number)}`, sprint: 5, status: 'approved', ...overrides });
/** The lane as the board shows it: open rows of sprint 5 with `status`, in list order. */
const numbersOf = (items: readonly ItemSummaryDto[], status = 'approved'): number[] =>
  items
    .filter((item) => item.status === status && item.state === 'open' && item.sprint === 5)
    .map((item) => item.number);

describe('placedInLane', () => {
  const items: ItemSummaryDto[] = [task(1), task(2), task(3), task(4, { status: 'qa' })];

  it('puts the task at the position the server answered, among its lane only', () => {
    const first = placedInLane(items, task(3, { queue: { position: 1, total: 3 }, version: 2 }));
    expect(numbersOf(first)).toEqual([3, 1, 2]);
    expect(numbersOf(first, 'qa')).toEqual([4]);
    expect(first.find((item) => item.number === 3)?.version).toBe(2);

    const down = placedInLane(items, task(1, { queue: { position: 2, total: 3 } }));
    expect(numbersOf(down)).toEqual([2, 1, 3]);
  });

  it('ignores closed rows and other sprints when counting the lane, and clamps a position past its end', () => {
    const withNoise = [...items, task(9, { state: 'closed', closedReason: 'not-planned' }), task(8, { sprint: 6 })];
    const placed = placedInLane(withNoise, task(2, { queue: { position: 7, total: 3 } }));
    expect(numbersOf(placed)).toEqual([1, 3, 2]);
    expect(placed.map((item) => item.number)).toContain(9);
    expect(placed.map((item) => item.number)).toContain(8);
  });

  it('only refreshes a task that is on no board any more', () => {
    const closed = task(2, { queue: null, state: 'closed', closedReason: 'not-planned', version: 3 });
    const placed = placedInLane(items, closed);
    expect(placed.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    expect(placed[1]).toBe(closed);
  });
});
