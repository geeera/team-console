import type { TrackerSprintDto } from '@shared/contracts';
import { quickTaskSprintOptionsOf } from './quick-task-sprint-options';

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

describe('quickTaskSprintOptionsOf', () => {
  it('names the current and next open sprint, defaulting to Next (#107)', () => {
    const options = quickTaskSprintOptionsOf(
      [sprint(3, '2026-12-01'), sprint(4, '2026-12-15'), sprint(2, '2026-11-01', 'closed')],
      '2026-11-10',
      3,
    );
    expect(options.current).toMatchObject({ sprint: { number: 3 }, disabledReason: null });
    expect(options.next).toMatchObject({ sprint: { number: 4 }, disabledReason: null });
    expect(options.backlog).toEqual({ target: 'backlog', sprint: null, disabledReason: null });
    expect(options.defaultTarget).toBe('next');
  });

  it('disables the current sprint during its freeze window, never the others', () => {
    const options = quickTaskSprintOptionsOf(
      [sprint(3, '2026-12-01'), sprint(4, '2026-12-15')],
      '2026-11-29',
      3,
    );
    expect(options.current).toMatchObject({ sprint: { number: 3 }, disabledReason: 'frozen' });
    expect(options.next).toMatchObject({ sprint: { number: 4 }, disabledReason: null });
  });

  it('falls back to the backlog by default when there is no next sprint', () => {
    const options = quickTaskSprintOptionsOf([sprint(3, '2026-12-01')], '2026-11-10', 3);
    expect(options.next).toEqual({ target: 'next', sprint: null, disabledReason: 'missing' });
    expect(options.defaultTarget).toBe('backlog');
  });

  it('marks current and next missing without any open sprint, and keeps the backlog enabled', () => {
    const options = quickTaskSprintOptionsOf([], '2026-11-10', 3);
    expect(options.current).toEqual({ target: 'current', sprint: null, disabledReason: 'missing' });
    expect(options.next).toEqual({ target: 'next', sprint: null, disabledReason: 'missing' });
    expect(options.backlog.disabledReason).toBeNull();
    expect(options.defaultTarget).toBe('backlog');
  });

  it('never disables the current sprint on a due date without a freeze match', () => {
    const options = quickTaskSprintOptionsOf([sprint(3, null)], '2026-11-10', 3);
    expect(options.current).toMatchObject({ sprint: { number: 3 }, disabledReason: null });
  });
});
