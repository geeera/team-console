import type { ItemSummaryDto, TrackerSprintDto } from '@shared/contracts';
import { moveMenuOf, moveTargetOf, SPRINT_CAP, type MoveMenuCopy } from './move-menu';

const sprint = (number: number, dueOn: string): TrackerSprintDto => ({
  number,
  title: `Sprint 0${String(number)}`,
  dueOn,
  state: 'open',
  description: '',
  createdAt: 'x',
  closedAt: null,
  openCount: 0,
});
const COPY: MoveMenuCopy = {
  label: 'Move TC-408',
  title: 'TC-408 · where to move it',
  sprintsGroup: 'Sprints',
  to: (s) => `To ${s.title}`,
  toCurrent: (s) => `To ${s.title} — current`,
  toBacklog: 'To the backlog',
  count: (n) => `${String(n)} tasks`,
  backlogCount: (n) => `${String(n)} tasks`,
  full: (n) => `Already ${String(n)}`,
  here: "It's here now",
  freeze: () => 'Freeze',
  inProgress: 'In progress',
};
const ITEM = { key: 'TC-408', title: 'Threat model', sprint: 3, status: 'approved' } as ItemSummaryDto;

describe('moveMenuOf', () => {
  const sprints = [sprint(3, '2026-11-13'), sprint(4, '2026-11-27')];

  it('offers every open sprint and the backlog, the current one marked, where it is now off', () => {
    const spec = moveMenuOf(
      {
        item: ITEM,
        sprints,
        counts: new Map([
          [3, 5],
          [4, 2],
          [null, 7],
        ]),
        today: '2026-11-05',
        freezeDays: 2,
      },
      COPY,
    );
    const items = spec.groups.flatMap((group) => group.items);
    expect(items.map((item) => [item.id, item.label, item.off ?? null, item.hint])).toEqual([
      ['sprint:3', 'To Sprint 03 — current', "It's here now", '5 tasks'],
      ['sprint:4', 'To Sprint 04', null, '2 tasks'],
      ['backlog', 'To the backlog', null, '7 tasks'],
    ]);
    expect(spec.warning).toBeUndefined();
  });

  it('turns the current sprint off in its freeze, warns from the cap without blocking, notes work in progress', () => {
    const spec = moveMenuOf(
      {
        item: { ...ITEM, sprint: null, status: 'in-progress' },
        sprints,
        counts: new Map([[4, SPRINT_CAP]]),
        today: '2026-11-12',
        freezeDays: 2,
      },
      COPY,
    );
    const [current, next] = spec.groups[0]?.items ?? [];
    expect(current?.off).toBe('Freeze');
    expect(next).toMatchObject({ hint: `Already ${String(SPRINT_CAP)}`, hintTone: 'warning' });
    expect(next?.off).toBeUndefined();
    expect(spec.groups[1]?.items[0]?.off).toBe("It's here now");
    expect(spec.warning).toBe('In progress');
  });

  it("freezes by the project's own freeze_days, not the plugin's default (#457)", () => {
    const menu = (freezeDays: number) =>
      moveMenuOf(
        { item: { ...ITEM, sprint: null }, sprints, counts: new Map(), today: '2026-11-09', freezeDays },
        COPY,
      ).groups[0]?.items[0]?.off;
    // Demo on the 13th: two freeze days start on the 11th, five on the 8th.
    expect(menu(2)).toBeUndefined();
    expect(menu(5)).toBe('Freeze');
  });

  it('reads a picked id back to a target', () => {
    expect(moveTargetOf('sprint:4')).toBe(4);
    expect(moveTargetOf('backlog')).toBeNull();
    expect(moveTargetOf('sprint:x')).toBeUndefined();
  });
});
