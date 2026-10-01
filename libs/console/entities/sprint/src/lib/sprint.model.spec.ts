import type { SprintDto, SprintIssueDto } from '@shared/contracts';
import {
  CORE_STATUSES,
  daysUntilDemo,
  demoDayOf,
  isSprintDto,
  NO_STATUS,
  SprintIssue,
  sprintBoardOf,
  statusColumnsOf,
} from './sprint.model';

function issueDto(number: number, overrides: Partial<SprintIssueDto> = {}): SprintIssueDto {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    state: 'open',
    status: 'approved',
    tier: 'standard',
    kind: 'feature',
    authorTrusted: true,
    ...overrides,
  };
}

function sprintDto(overrides: Partial<SprintDto> = {}): SprintDto {
  return {
    milestone: { number: 1, title: 'Sprint 01', dueOn: '2026-10-16', url: 'https://github.com/o/r/milestone/1' },
    issues: [issueDto(1)],
    byStatus: { approved: 1 },
    planned: 1,
    shipped: 0,
    carriedOver: 1,
    byTier: { standard: { planned: 1, shipped: 0, raised: 0 } },
    openPullRequests: [
      { number: 5, title: 'PR', url: 'https://github.com/o/r/pull/5', draft: false, authorTrusted: true },
    ],
    ...overrides,
  };
}

function issue(number: number, status: string | null): SprintIssue {
  return { ...issueDto(number, { status }) };
}

describe('isSprintDto', () => {
  it('accepts the read model, with and without a current sprint', () => {
    expect(isSprintDto(sprintDto())).toBe(true);
    expect(isSprintDto(sprintDto({ milestone: null, issues: [], byStatus: {}, byTier: {} }))).toBe(true);
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['a milestone without a day', sprintDto({ milestone: { number: 1, title: 'S', dueOn: '16.10', url: null } })],
    ['an unknown tier', sprintDto({ issues: [{ ...issueDto(1), tier: 'huge' as never }] })],
    ['an unknown issue state', sprintDto({ issues: [{ ...issueDto(1), state: 'merged' as never }] })],
    ['a title that is not text', sprintDto({ issues: [{ ...issueDto(1), title: 7 as never }] })],
    ['a missing trust flag', sprintDto({ issues: [{ ...issueDto(1), authorTrusted: undefined as never }] })],
    ['a negative count', sprintDto({ planned: -1 })],
    ['a byStatus count that is not a number', sprintDto({ byStatus: { approved: '1' as never } })],
    [
      'a pull request without a draft flag',
      sprintDto({ openPullRequests: [{ number: 5, title: 'x', url: null, authorTrusted: true } as never] }),
    ],
  ])('refuses %s', (_, value) => {
    expect(isSprintDto(value)).toBe(false);
  });
});

describe('sprintBoardOf', () => {
  it('keeps github.com links and drops any other', () => {
    const board = sprintBoardOf(
      sprintDto({
        milestone: { number: 1, title: 'Sprint 01', dueOn: '2026-10-16', url: 'javascript:alert(1)' },
        issues: [
          issueDto(1, { url: 'https://github.com.evil.example/o/r/issues/1' }),
          issueDto(2, { url: 'https://github.com/o/r/issues/2' }),
        ],
        openPullRequests: [{ number: 5, title: 'x', url: 'http://github.com/o/r/pull/5', draft: true, authorTrusted: false }],
      }),
    );

    expect(board.milestone?.url).toBeNull();
    expect(board.issues.map((item) => item.url)).toEqual([null, 'https://github.com/o/r/issues/2']);
    expect(board.pullRequests[0]).toEqual({ number: 5, title: 'x', url: null, draft: true, authorTrusted: false });
  });

  it('passes untrusted titles through unchanged — escaping is the template’s job', () => {
    const title = '<img src=x onerror=alert(1)>';
    expect(sprintBoardOf(sprintDto({ issues: [issueDto(1, { title })] })).issues[0]?.title).toBe(title);
  });
});

describe('statusColumnsOf', () => {
  it('always shows the core lanes, in workflow order, even when empty', () => {
    expect(statusColumnsOf([]).map((column) => column.status)).toEqual([...CORE_STATUSES]);
  });

  it('adds a lane per other status in workflow order, unknown labels after, no label last', () => {
    const columns = statusColumnsOf([
      issue(1, null),
      issue(2, 'zzz-custom'),
      issue(3, 'blocked'),
      issue(4, 'proposed'),
      issue(5, 'qa'),
    ]);

    expect(columns.map((column) => column.status)).toEqual([
      'proposed',
      'approved',
      'in-progress',
      'qa',
      'blocked',
      'done',
      'zzz-custom',
      NO_STATUS,
    ]);
  });

  it('puts each issue in exactly one lane, by number within it', () => {
    const issues = [issue(9, 'done'), issue(3, 'done'), issue(4, 'in-progress'), issue(7, null)];
    const columns = statusColumnsOf(issues);
    const byStatus = Object.fromEntries(columns.map((column) => [column.status, column.issues.map((i) => i.number)]));

    expect(byStatus).toEqual({ approved: [], 'in-progress': [4], qa: [], done: [3, 9], none: [7] });
    expect(columns.reduce((sum, column) => sum + column.issues.length, 0)).toBe(issues.length);
  });
});

describe('demo day', () => {
  it('prints the due day itself in any time zone within ±11 h of UTC', () => {
    expect(demoDayOf('2026-10-16').toISOString()).toBe('2026-10-16T12:00:00.000Z');
  });

  it('counts whole days from the reader’s local today', () => {
    const lateEvening = new Date(2026, 9, 1, 23, 30);
    expect(daysUntilDemo('2026-10-16', lateEvening)).toBe(15);
    expect(daysUntilDemo('2026-10-01', new Date(2026, 9, 1, 0, 5))).toBe(0);
    expect(daysUntilDemo('2026-09-30', new Date(2026, 9, 1, 9, 0))).toBe(-1);
  });
});
