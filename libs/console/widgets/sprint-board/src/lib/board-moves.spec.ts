import { Component, Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { itemFixture } from '@console/entities/item';
import type { ItemMove } from '@console/features/move-item';
import type { ItemDto, ItemSummaryDto } from '@shared/contracts';
import { itemsAfterMove, movesSection, placedInLane, type MoveFocusContext } from './board-moves';

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

describe('movesSection', () => {
  const move = (overrides: Partial<ItemMove> = {}): ItemMove => ({
    item: task(3),
    from: 5,
    to: null,
    isUndo: false,
    ...overrides,
  });

  it('is touched when the task left this section', () => {
    expect(movesSection(move({ from: 5, to: null }), 5)).toBe(true);
  });

  it('is touched when the task joined this section', () => {
    expect(movesSection(move({ from: null, to: 5 }), 5)).toBe(true);
  });

  it('is untouched when the move is between two other sections', () => {
    expect(movesSection(move({ from: 4, to: null }), 5)).toBe(false);
  });
});

describe('itemsAfterMove', () => {
  @Component({ template: '' })
  class Host {}

  let injector: Injector;
  let root: HTMLElement;
  const items: ItemSummaryDto[] = [task(1), task(2), task(3)];

  function context(arrivals: WritableSignal<readonly number[]>): MoveFocusContext {
    return { root, injector, fallback: () => null, arrivals };
  }

  beforeAll(() => {
    // jsdom has no matchMedia; Sheet (read by focusAfterRender) asks it whether the viewport is a phone.
    window.matchMedia ??= ((media: string) => ({ matches: false, media }) as MediaQueryList) as typeof window.matchMedia;
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    injector = fixture.componentRef.injector;

    root = document.createElement('div');
    root.innerHTML = `
      <tc-lane data-status="approved">
        <h2 role="heading">Approved</h2>
        <tc-list-row data-number="1"><button data-move="1" type="button">1</button></tc-list-row>
        <tc-list-row data-number="2"><button data-move="2" type="button">2</button></tc-list-row>
        <tc-list-row data-number="3"><button data-move="3" type="button">3</button></tc-list-row>
      </tc-lane>
    `;
    document.body.append(root);
    document.body.focus();
  });

  afterEach(() => {
    root.remove();
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('drops the row that left this section, leaving the rest untouched', () => {
    const arrivals = signal<readonly number[]>([]);
    const move: ItemMove = { item: task(3, { sprint: null }), from: 5, to: null, isUndo: false };
    const next = itemsAfterMove(move, 5, items, context(arrivals));
    expect(next.map((item) => item.number)).toEqual([1, 2]);
    expect(arrivals()).toEqual([]);
  });

  it('adds the joining task at the end of its lane and tracks the arrival', () => {
    const arrivals = signal<readonly number[]>([]);
    const move: ItemMove = { item: task(4), from: null, to: 5, isUndo: false };
    const next = itemsAfterMove(move, 5, items, context(arrivals));
    expect(next.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    expect(arrivals()).toEqual([4]);
  });

  it('adds the task back on Undo without tracking it as a new arrival', () => {
    const arrivals = signal<readonly number[]>([7]);
    root.querySelector('tc-lane')?.insertAdjacentHTML(
      'beforeend',
      '<tc-list-row data-number="4"><button data-move="4" type="button">4</button></tc-list-row>',
    );
    const move: ItemMove = { item: task(4), from: null, to: 5, isUndo: true };
    const next = itemsAfterMove(move, 5, items, context(arrivals));
    expect(next.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    expect(arrivals()).toEqual([7]);
  });

  it('moves focus to the ⋯ of the row that takes the leaving row’s place', async () => {
    const arrivals = signal<readonly number[]>([]);
    const button2 = root.querySelector('[data-move="2"]') as HTMLButtonElement;
    const move: ItemMove = { item: task(3, { sprint: null }), from: 5, to: null, isUndo: false };
    itemsAfterMove(move, 5, items, context(arrivals));
    await settle();
    expect(document.activeElement).toBe(button2);
  });

  it('returns focus to its own ⋯ on Undo, instead of the neighbour that leaving would use', async () => {
    const arrivals = signal<readonly number[]>([]);
    root.querySelector('tc-lane')?.insertAdjacentHTML(
      'beforeend',
      '<tc-list-row data-number="4"><button data-move="4" type="button">4</button></tc-list-row>',
    );
    const button4 = root.querySelector('[data-move="4"]') as HTMLButtonElement;
    const move: ItemMove = { item: task(4), from: null, to: 5, isUndo: true };
    itemsAfterMove(move, 5, items, context(arrivals));
    await settle();
    expect(document.activeElement).toBe(button4);
  });
});
