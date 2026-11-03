import type { OverviewProjectReadDto } from '@shared/contracts';
import { isOverviewDto } from './overview';

const row: OverviewProjectReadDto = {
  kind: 'read',
  slug: 'alpha',
  name: 'Alpha',
  team: 'running',
  sprint: null,
  needsYou: [],
  setup: false,
  setupUrl: null,
  snooze: { snoozed: false },
};

const bodyOf = (project: unknown) => ({ projects: [project], checkedAt: '2026-10-01T12:00:00Z' });

describe('isOverviewDto: the snooze of a read row (#222)', () => {
  it.each([
    { snoozed: false },
    { snoozed: true, until: null, allowsUrgent: true, since: '2026-10-01T09:00:00Z' },
    { snoozed: true, until: '2026-10-02T06:00:00Z', allowsUrgent: false, since: '2026-10-01T09:00:00Z' },
  ])('accepts %j', (snooze) => {
    expect(isOverviewDto(bodyOf({ ...row, snooze }))).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['without allowsUrgent', { snoozed: true, until: null, since: '2026-10-01T09:00:00Z' }],
    ['with an unreadable until', { snoozed: true, until: 'soon', allowsUrgent: true, since: '2026-10-01T09:00:00Z' }],
  ])('refuses a snooze %s', (_case, snooze) => {
    expect(isOverviewDto(bodyOf({ ...row, snooze }))).toBe(false);
  });

  it('asks no snooze of a project that could not be read', () => {
    const failed = { kind: 'failed', slug: 'b', name: 'B', problem: { type: 'x', title: 'x', status: 502 } };
    expect(isOverviewDto(bodyOf(failed))).toBe(true);
  });
});
