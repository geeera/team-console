import {
  isGitHubPullRequest,
  pullRequestRecordOf,
  type MilestoneRecord,
  type PullRequestRecord,
} from './github-records';
import {
  buildSprint,
  declaredTier,
  effectiveTier,
  nextSprintNumber,
  pickCurrentSprint,
  pickNextSprint,
  sprintToday,
} from './sprint';

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

describe('pickNextSprint', () => {
  const current = milestone(3, '2026-10-14T12:00:00Z');

  it('takes the open milestone due soonest after the current demo', () => {
    const next = pickNextSprint(
      [milestone(1, '2026-09-30T00:00:00Z', 'closed'), current, milestone(5, '2026-11-11T12:00:00Z'), milestone(4, '2026-10-28T12:00:00Z')],
      current,
    );
    expect(next?.number).toBe(4);
  });

  it('skips closed milestones, ones without a due date and ones due the same day as the current demo', () => {
    expect(
      pickNextSprint(
        [current, milestone(6, null), milestone(7, '2026-10-28T12:00:00Z', 'closed'), milestone(8, '2026-10-14T00:00:00Z')],
        current,
      ),
    ).toBeNull();
  });
});

describe('nextSprintNumber', () => {
  const titled = (title: string, state = 'open'): MilestoneRecord => ({ ...milestone(1, null, state), title });

  it('is the highest Sprint NN, open or closed, + 1 (gaps are not filled)', () => {
    expect(nextSprintNumber([titled('Sprint 01', 'closed'), titled('Sprint 04', 'closed'), titled('Sprint 02')])).toBe(5);
  });

  it('ignores milestones that are not sprints', () => {
    expect(nextSprintNumber([titled('Release 9'), titled('Sprint 02')])).toBe(3);
  });

  it('is 1 without any sprint yet', () => {
    expect(nextSprintNumber([])).toBe(1);
    expect(nextSprintNumber([titled('Launch')])).toBe(1);
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
          headSha: null,
          authorAssociation: 'NONE',
          authorLogin: 'outsider',
          authorType: 'User',
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
      openPullRequests: [
        { number: 7, title: '<b>x</b>', url: null, draft: true, authorTrusted: false, ci: 'unknown' },
      ],
    });
  });

  it("carries each pull request's CI state (#131); one not read is unknown", () => {
    const pull = (number: number): PullRequestRecord => ({
      number,
      title: `PR ${number}`,
      htmlUrl: `https://github.com/geeera/team-console/pull/${number}`,
      draft: false,
      headSha: null,
      authorAssociation: 'OWNER',
      authorLogin: 'geeera',
      authorType: 'User',
    });
    const sprint = buildSprint({
      milestone: null,
      milestoneIssues: [],
      openPullRequests: [pull(3), pull(2), pull(1)],
      ciStates: new Map([
        [3, 'failure'],
        [2, 'pending'],
      ]),
    });
    expect(sprint.openPullRequests.map(({ number, ci }) => [number, ci])).toEqual([
      [3, 'failure'],
      [2, 'pending'],
      [1, 'unknown'],
    ]);
  });
});

describe('pullRequestRecordOf: head sha (#131)', () => {
  const raw = (head: unknown): Record<string, unknown> => ({
    number: 5,
    title: 'x',
    html_url: 'https://github.com/o/r/pull/5',
    author_association: 'OWNER',
    user: { login: 'geeera', type: 'User' },
    head,
  });
  const sha = 'a'.repeat(40);

  it.each([
    ['a SHA-1', { sha }, sha],
    ['a SHA-256', { sha: 'b'.repeat(64) }, 'b'.repeat(64)],
    ['a path', { sha: '../../issues' }, null],
    ['upper case', { sha: 'A'.repeat(40) }, null],
    ['no head', undefined, null],
    ['a string head', sha, null],
  ])('keeps %s as %j', (_name, head, expected) => {
    const value = raw(head);
    expect(isGitHubPullRequest(value)).toBe(true);
    if (isGitHubPullRequest(value)) {
      expect(pullRequestRecordOf(value).headSha).toBe(expected);
    }
  });
});
