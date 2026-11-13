import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { itemFixture, ItemsApi, type TrackerWrite } from '@console/entities/item';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Menu, Toaster } from '@console/shared/ui';
import type { ItemDto, TrackerSprintDto } from '@shared/contracts';
import { ItemMover, type ItemMove, type MoveHandlers } from './item-mover';

const sprint = (number: number, dueOn: string): TrackerSprintDto => ({
  number,
  title: `Sprint 0${String(number)}`,
  dueOn,
  state: 'open',
  description: '',
  createdAt: '2026-11-01T00:00:00Z',
  closedAt: null,
  openCount: 0,
});

const ITEM: ItemDto = itemFixture({ key: 'TC-408', number: 408, title: 'Threat model', sprint: 3, version: 7 });

class FakeItems {
  readonly updates: { version: number; sprint: number | null | undefined; key: string }[] = [];
  answers: TrackerWrite<ItemDto>[] = [];

  async sprints() {
    return { ok: true as const, value: [sprint(3, '2030-01-15'), sprint(4, '2030-01-29')] };
  }

  async items() {
    return { ok: true as const, value: [ITEM] };
  }

  async freezeDays() {
    return { ok: true as const, value: 2 };
  }

  async update(_slug: string, _n: number, version: number, change: { sprint?: number | null }, key: string) {
    this.updates.push({ version, sprint: change.sprint, key });
    return (
      this.answers.shift() ?? {
        ok: true as const,
        value: { ...ITEM, sprint: change.sprint ?? null, version: version + 1 },
        replayed: false,
      }
    );
  }
}

async function setup(picked: string | null) {
  const items = new FakeItems();
  const menu = { open: vi.fn(async () => picked) };
  await TestBed.configureTestingModule({
    providers: [provideConsoleI18n(), { provide: ItemsApi, useValue: items }, { provide: Menu, useValue: menu }],
  }).compileComponents();
  await TestBed.inject(ApplicationInitStatus).donePromise;
  const moves: ItemMove[] = [];
  const failures: unknown[] = [];
  const handlers: MoveHandlers = {
    moved: (move) => moves.push(move),
    failed: (failed) => failures.push(failed),
  };
  const mover = TestBed.inject(ItemMover);
  mover.now = () => new Date('2030-01-02T12:00:00Z');
  return { items, menu, moves, failures, handlers, mover, toaster: TestBed.inject(Toaster) };
}

describe('ItemMover (#409 §2.2, #558)', () => {
  it('moves at once with If-Match and a key, offers Undo, and Undo moves it back on the new version', async () => {
    const { items, menu, moves, handlers, mover, toaster } = await setup('sprint:4');
    await mover.open(document.body, 'team-console', ITEM, handlers);

    expect(menu.open).toHaveBeenCalledTimes(1);
    expect(items.updates).toEqual([{ version: 7, sprint: 4, key: expect.any(String) }]);
    expect(moves).toEqual([{ item: expect.objectContaining({ sprint: 4, version: 8 }), from: 3, to: 4, isUndo: false }]);
    expect(toaster.message()).toBe('TC-408 → Sprint 04');

    expect(toaster.runUndo()).toBe(true);
    await vi.waitFor(() => expect(moves).toHaveLength(2));
    expect(items.updates[1]).toMatchObject({ version: 8, sprint: 3 });
    expect(items.updates[1]?.key).not.toBe(items.updates[0]?.key);
    expect(moves[1]).toMatchObject({ from: 4, to: 3, isUndo: true });
    expect(toaster.message()).toBe('Возвращено: TC-408 снова в Sprint 03');
    expect(toaster.undo()).toBeNull();
  });

  it('does nothing when the menu closes without a pick or on where the task is', async () => {
    for (const picked of [null, 'sprint:3']) {
      TestBed.resetTestingModule();
      const { items, moves, handlers, mover } = await setup(picked);
      await mover.open(document.body, 'team-console', ITEM, handlers);
      expect(items.updates).toHaveLength(0);
      expect(moves).toHaveLength(0);
    }
  });

  it('hands a refused move up, nothing moved, and its retry repeats the same key', async () => {
    const { items, moves, failures, handlers, mover } = await setup('backlog');
    items.answers.push({ ok: false, failure: { kind: 'frozen', field: null, retryAfter: null } });
    await mover.open(document.body, 'team-console', ITEM, handlers);

    expect(moves).toHaveLength(0);
    expect(failures).toEqual([{ failure: expect.objectContaining({ kind: 'frozen' }), retry: expect.any(Function) }]);
    await (failures[0] as { retry: () => Promise<void> }).retry();
    expect(items.updates[1]?.key).toBe(items.updates[0]?.key);
    expect(moves).toHaveLength(1);
  });
});
