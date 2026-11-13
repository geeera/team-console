import type { ItemStatus, ItemSummaryDto, TrackerSprintDto } from '@shared/contracts';
import { boardSectionsOf, trackerSprintPartOf } from './tracker-board';

let nextNumber = 1;

function item(overrides: Partial<ItemSummaryDto> = {}): ItemSummaryDto {
  const number = overrides.number ?? nextNumber++;
  return {
    key: `TC-${String(number)}`,
    number,
    kind: 'feature',
    status: 'approved',
    severity: null,
    tier: 'standard',
    sprint: null,
    title: `Item ${String(number)}`,
    labels: [],
    flags: [],
    state: 'open',
    closedAt: null,
    closedReason: null,
    createdBy: { kind: 'owner', name: 'owner' },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    version: 1,
    source: 'console',
    sourceUrl: null,
    ...overrides,
  };
}

function sprint(number: number, dueOn: string | null, state: 'open' | 'closed' = 'open'): TrackerSprintDto {
  return {
    number,
    title: `Sprint ${String(number).padStart(2, '0')}`,
    dueOn,
    state,
    description: '',
    createdAt: '2026-11-01T10:00:00.000Z',
    closedAt: null,
    openCount: 0,
  };
}

describe('boardSectionsOf (#556)', () => {
  it('takes the earliest open sprint as current and orders the future ones by demo date', () => {
    const sprints = [
      sprint(6, '2026-12-25'),
      sprint(3, '2026-11-01', 'closed'),
      sprint(5, '2026-12-11'),
      sprint(4, '2026-11-27'),
      sprint(7, null),
    ];
    const sections = boardSectionsOf(sprints, []);
    expect(sections.current?.sprint?.number).toBe(4);
    expect(sections.future.map((section) => [section.kind, section.sprint?.number])).toEqual([
      ['next', 5],
      ['later', 6],
      ['later', 7],
    ]);
    expect(sections.backlog).toMatchObject({ kind: 'backlog', sprint: null, openCount: 0 });
  });

  it('lays lanes out in workflow order, an unknown status after Done and No status last, with each row’s kind', () => {
    const items = [
      item({ status: 'done', state: 'closed' }),
      item({ status: 'review' as ItemStatus, kind: 'bug' }),
      item({ status: null as unknown as ItemStatus }),
      item({ status: 'blocked' }),
      item({ status: 'proposed', kind: 'chore' }),
      item({ status: 'in-progress' }),
    ];
    const { backlog } = boardSectionsOf([], items);
    expect(backlog.lanes.map((lane) => lane.status)).toEqual([
      'proposed',
      'approved',
      'in-progress',
      'qa',
      'blocked',
      'done',
      'review',
      'none',
    ]);
    expect(backlog.lanes.find((lane) => lane.status === 'review')?.issues[0]?.kind).toBe('bug');
    expect(backlog.openCount).toBe(5);
  });

  it('keeps a lane in the order the tracker listed it: the queue, not the number (#456)', () => {
    const { backlog } = boardSectionsOf([], [item({ number: 9 }), item({ number: 3 }), item({ number: 5 })]);
    expect(backlog.lanes.find((lane) => lane.status === 'approved')?.issues.map((issue) => issue.number)).toEqual([
      9, 3, 5,
    ]);
  });

  it('has no current or future section without open sprints, and an empty backlog without items', () => {
    const sections = boardSectionsOf([sprint(1, '2026-10-01', 'closed')], [item({ sprint: 1 })]);
    expect(sections.current).toBeNull();
    expect(sections.future).toEqual([]);
    expect(sections.backlog.openCount).toBe(0);
    expect(sections.backlog.lanes.every((lane) => lane.issues.length === 0)).toBe(true);
  });

  it('counts every open item of a section, however many pages they were read in', () => {
    const items = [
      ...Array.from({ length: 140 }, () => item({ sprint: 4 })),
      ...Array.from({ length: 3 }, () => item({ sprint: 4, status: 'done', state: 'closed' })),
      ...Array.from({ length: 120 }, () => item({ sprint: null })),
      ...Array.from({ length: 7 }, () => item({ sprint: 5 })),
    ];
    const sections = boardSectionsOf([sprint(4, '2026-11-27'), sprint(5, '2026-12-11')], items);
    expect(sections.current?.openCount).toBe(140);
    expect(sections.future[0]?.openCount).toBe(7);
    expect(sections.backlog.openCount).toBe(120);
  });
});

describe('trackerSprintPartOf (#556)', () => {
  it('gives #18’s board the tracker sprint, its rows and the done tile’s counts', () => {
    const current = sprint(4, '2026-11-27');
    const part = trackerSprintPartOf(current, [
      item({ number: 9, sprint: 4, status: 'done', state: 'closed', tier: null }),
      item({ number: 8, sprint: 4, kind: 'question' }),
      item({ number: 7, sprint: 4, createdBy: { kind: 'import', name: 'someone' } }),
      item({ number: 6, sprint: null }),
    ]);
    expect(part.milestone).toEqual({ number: 4, title: 'Sprint 04', dueOn: '2026-11-27', url: null });
    // The tracker's order is the queue (#456): kept as listed, never re-sorted by number.
    expect(part.issues.map((issue) => issue.number)).toEqual([9, 8, 7]);
    expect(part.issues[2]).toMatchObject({ url: null, authorTrusted: false, request: null });
    expect(part.issues[0]).toMatchObject({ tier: 'standard', state: 'closed' });
    expect(part).toMatchObject({ planned: 2, shipped: 1, carriedOver: 1 });
  });

  it('is the no-sprint board without an open sprint', () => {
    expect(trackerSprintPartOf(null, [item({ sprint: 4 })])).toEqual({
      milestone: null,
      issues: [],
      planned: 0,
      shipped: 0,
      carriedOver: 0,
    });
  });
});
