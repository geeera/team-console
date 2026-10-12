import type { MilestoneRecord } from '@worker/read-models';
import {
  calendarOf,
  freezeStartsNow,
  moveDemoRefusal,
  nextSprintRefusal,
  sprintPlanOf,
  teamSprintOf,
} from './sprint-plan';

const TODAY = '2026-10-05';

function milestone(number: number, title: string, dueOn: string | null, state = 'open'): MilestoneRecord {
  return { number, title, state, dueOn, htmlUrl: `https://github.com/o/r/milestone/${number}` };
}

const S03 = milestone(3, 'Sprint 03', '2026-09-30T12:00:00Z', 'closed');
const S04 = milestone(4, 'Sprint 04', '2026-10-14T12:00:00Z');
const S05 = milestone(5, 'Sprint 05', '2026-10-28T00:00:00Z');

describe('sprintPlanOf', () => {
  it('finds the current sprint, the next one and the next title among open and closed milestones', () => {
    const plan = sprintPlanOf([S03, S04, S05], TODAY, 2);
    expect(plan).toEqual({
      today: TODAY,
      freezeDays: 2,
      current: { number: 4, title: 'Sprint 04', due: '2026-10-14' },
      next: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
      nextTitle: 'Sprint 06',
    });
    expect(teamSprintOf(plan)).toEqual({
      number: 4,
      title: 'Sprint 04',
      due: '2026-10-14',
      freeze: { from: '2026-10-12', to: '2026-10-14' },
      next: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
    });
    expect(calendarOf(plan)).toEqual({ today: TODAY, freezeDays: 2, nextTitle: 'Sprint 06' });
  });

  it('never reuses the number of a closed sprint and skips gaps', () => {
    const plan = sprintPlanOf([milestone(9, 'Sprint 07', '2026-09-01T12:00:00Z', 'closed'), S04], TODAY, 2);
    expect(plan.nextTitle).toBe('Sprint 08');
  });

  it('has no current sprint when every open milestone is past or undated, and starts at Sprint 01', () => {
    const plan = sprintPlanOf(
      [milestone(1, 'Launch', null), milestone(2, 'Old', '2026-10-01T12:00:00Z')],
      TODAY,
      2,
    );
    expect(plan.current).toBeNull();
    expect(plan.next).toBeNull();
    expect(plan.nextTitle).toBe('Sprint 01');
    expect(teamSprintOf(plan)).toBeNull();
  });
});

describe('moveDemoRefusal (#29 §1)', () => {
  const plan = sprintPlanOf([S04, S05], TODAY, 2);
  const move = (due: string, expectedDue = '2026-10-14') => moveDemoRefusal(plan, { due, expectedDue });

  it('accepts a later or earlier day before the next demo', () => {
    expect(move('2026-10-16')).toBeNull();
    expect(move('2026-10-07')).toBeNull();
    expect(move(TODAY)).toBeNull();
    expect(move('2026-10-27')).toBeNull();
  });

  it.each([
    ['no current sprint', sprintPlanOf([], TODAY, 2), '2026-10-16', '2026-10-14', { type: 'sprint-none' }],
    [
      'the due changed meanwhile',
      plan,
      '2026-10-16',
      '2026-10-13',
      { type: 'sprint-changed', due: '2026-10-14' },
    ],
    ['the same day', plan, '2026-10-14', '2026-10-14', { type: 'sprint-unchanged' }],
    ['yesterday (Kyiv)', plan, '2026-10-04', '2026-10-14', { type: 'sprint-date-past', today: TODAY }],
    [
      'the next demo day',
      plan,
      '2026-10-28',
      '2026-10-14',
      { type: 'sprint-date-after-next', next: { number: 5, title: 'Sprint 05', due: '2026-10-28' } },
    ],
    [
      'after the next demo',
      plan,
      '2026-11-02',
      '2026-10-14',
      { type: 'sprint-date-after-next', next: { number: 5, title: 'Sprint 05', due: '2026-10-28' } },
    ],
  ])('refuses %s', (_label, subject, due, expectedDue, refusal) => {
    expect(moveDemoRefusal(subject, { due, expectedDue })).toEqual(refusal);
  });

  it('checks a changed due before anything else about the date', () => {
    expect(move('2026-10-01', '2026-10-10')).toEqual({ type: 'sprint-changed', due: '2026-10-14' });
  });

  it('accepts any future day when there is no next sprint', () => {
    expect(
      moveDemoRefusal(sprintPlanOf([S04], TODAY, 2), { due: '2027-01-15', expectedDue: '2026-10-14' }),
    ).toBeNull();
  });
});

describe('freezeStartsNow', () => {
  it('is true when today lands inside the new freeze, demo day included', () => {
    const plan = sprintPlanOf([S04], TODAY, 2);
    expect(freezeStartsNow(plan, '2026-10-06')).toBe(true);
    expect(freezeStartsNow(plan, '2026-10-07')).toBe(true);
    expect(freezeStartsNow(plan, TODAY)).toBe(true);
    expect(freezeStartsNow(plan, '2026-10-08')).toBe(false);
  });

  it('follows freeze_days', () => {
    expect(freezeStartsNow(sprintPlanOf([S04], TODAY, 0), '2026-10-06')).toBe(false);
    expect(freezeStartsNow(sprintPlanOf([S04], TODAY, 5), '2026-10-10')).toBe(true);
  });
});

describe('nextSprintRefusal (#29 §2)', () => {
  const withCurrent = sprintPlanOf([S03, S04], TODAY, 2);

  it('accepts a day after the current demo', () => {
    expect(nextSprintRefusal(withCurrent, { due: '2026-10-28', expectedCurrent: 'Sprint 04' })).toBeNull();
    expect(nextSprintRefusal(withCurrent, { due: '2026-10-15', expectedCurrent: 'Sprint 04' })).toBeNull();
  });

  it('accepts today or later without a current sprint', () => {
    const none = sprintPlanOf([S03], TODAY, 2);
    expect(nextSprintRefusal(none, { due: TODAY, expectedCurrent: null })).toBeNull();
    expect(nextSprintRefusal(none, { due: '2026-10-04', expectedCurrent: null })).toEqual({
      type: 'sprint-date-early',
      after: '2026-10-04',
    });
  });

  it.each([
    ['the demo day of the current sprint', '2026-10-14', { type: 'sprint-date-early', after: '2026-10-14' }],
    ['a day before it', '2026-10-10', { type: 'sprint-date-early', after: '2026-10-14' }],
  ])('refuses %s', (_label, due, refusal) => {
    expect(nextSprintRefusal(withCurrent, { due, expectedCurrent: 'Sprint 04' })).toEqual(refusal);
  });

  it('refuses when the current sprint is not the one the owner saw', () => {
    expect(nextSprintRefusal(withCurrent, { due: '2026-10-28', expectedCurrent: null })).toEqual({
      type: 'sprint-changed',
      current: { number: 4, title: 'Sprint 04', due: '2026-10-14' },
    });
    expect(
      nextSprintRefusal(sprintPlanOf([], TODAY, 2), { due: '2026-10-28', expectedCurrent: 'Sprint 04' }),
    ).toEqual({
      type: 'sprint-changed',
      current: null,
    });
  });

  it('refuses when the next sprint exists already', () => {
    expect(
      nextSprintRefusal(sprintPlanOf([S04, S05], TODAY, 2), {
        due: '2026-11-11',
        expectedCurrent: 'Sprint 04',
      }),
    ).toEqual({ type: 'sprint-exists', title: 'Sprint 05', due: '2026-10-28' });
  });
});
