import type { MilestoneRecord } from './github-records';
import { buildSprint, declaredTier, effectiveTier, pickCurrentSprint, sprintToday } from './sprint';

function milestone(number: number, dueOn: string | null, state = 'open'): MilestoneRecord {
  return { number, title: `M${number}`, state, dueOn, htmlUrl: `https://github.com/o/r/milestone/${number}` };
}

describe('pickCurrentSprint (calendar.pick_current_sprint)', () => {
  it('takes the open milestone due soonest, today included', () => {
    const picked = pickCurrentSprint(
      [
        milestone(1, '2026-09-29T00:00:00Z'),
        milestone(2, '2026-10-16T00:00:00Z'),
        milestone(3, '2026-09-30T07:00:00Z'),
      ],
      '2026-09-30',
    );
    expect(picked?.number).toBe(3);
  });

  it('skips closed milestones and ones without a due date; none left → null', () => {
    expect(
      pickCurrentSprint([milestone(1, null), milestone(2, '2026-12-01T00:00:00Z', 'closed')], '2026-09-30'),
    ).toBeNull();
  });

  it('keeps the first of two milestones due the same day', () => {
    const picked = pickCurrentSprint(
      [milestone(5, '2026-10-16T00:00:00Z'), milestone(4, '2026-10-16T08:00:00Z')],
      '2026-09-30',
    );
    expect(picked?.number).toBe(5);
  });
});

describe('sprintToday', () => {
  it('is the Kyiv date (the plugin calendar), not the UTC one', () => {
    // 2026-09-30 22:30 UTC is already 1 October in Kyiv (UTC+3).
    expect(sprintToday(Date.UTC(2026, 8, 30, 22, 30))).toBe('2026-10-01');
    expect(sprintToday(Date.UTC(2026, 8, 30, 20, 0))).toBe('2026-09-30');
  });
});

describe('tiers (tiers.declared / tiers.effective)', () => {
  it.each([
    [['tier:light'], 'light', 'light'],
    [['tier:light', 'tier-up'], 'light', 'standard'],
    [['tier:heavy', 'tier-up'], 'heavy', 'heavy'],
    [['tier:standard', 'tier-up', 'security'], 'standard', 'standard'],
    [['tier:heavy', 'security'], 'heavy', 'standard'],
    [['tier:light', 'tier:heavy'], 'standard', 'standard'],
    [['tier:huge'], 'standard', 'standard'],
    [[], 'standard', 'standard'],
  ])('%j → declared %s, built %s', (labels, declared, effective) => {
    expect(declaredTier(labels)).toBe(declared);
    expect(effectiveTier(labels)).toBe(effective);
  });
});

describe('buildSprint', () => {
  it('without a current sprint still lists the open pull requests, safely', () => {
    const sprint = buildSprint({
      milestone: null,
      milestoneIssues: [],
      openPullRequests: [
        {
          number: 7,
          title: '<b>x</b>',
          htmlUrl: 'javascript:alert(1)',
          draft: true,
          authorAssociation: 'NONE',
        },
      ],
    });
    expect(sprint).toEqual({
      milestone: null,
      issues: [],
      byStatus: {},
      planned: 0,
      shipped: 0,
      carriedOver: 0,
      byTier: {},
      openPullRequests: [{ number: 7, title: '<b>x</b>', url: null, draft: true, authorTrusted: false }],
    });
  });
});
