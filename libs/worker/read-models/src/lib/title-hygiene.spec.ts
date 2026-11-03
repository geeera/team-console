import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoArtifactsOf } from './artifacts/demo';
import { designArtifactsOf } from './artifacts/designs';
import type { IssueRecord, MilestoneRecord, PullRequestRecord } from './github-records';
import { buildInbox, buildQuestions, needsOf } from './inbox';
import { buildNeedsYou } from './needs-you';
import { buildOverviewRow } from './overview';
import { buildSprint } from './sprint';

/**
 * #287 guard: every DTO that carries a GitHub title strips invisible characters, so an outsider's item cannot pose
 * as another. Two checks: the source of every title-building module (the read models here and the api routes)
 * wraps each `title: <record>.title` in `withoutInvisibles(…)`, and every builder's output holds no such character
 * under any `title` key when the records are hostile.
 */

const [rlo, pdf, zwsp, tag] = [0x202e, 0x202c, 0x200b, 0xe0041].map((point) => String.fromCodePoint(point));
const HOSTILE = `Approve ${rlo}nalp${pdf} the${zwsp} plan${tag}`;
const CLEAN = 'Approve nalp the plan';
// The helper's set, spelled independently here so the guard does not lean on the helper it checks.
const INVISIBLE = new RegExp(
  `[${[
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0xad, 0xad],
    [0x61c, 0x61c],
    [0x115f, 0x1160],
    [0x200b, 0x200c],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0x3164, 0x3164],
    [0xfeff, 0xfeff],
    [0xe0000, 0xe007f],
  ]
    .map(([from, to]) => `\\u{${from?.toString(16)}}-\\u{${to?.toString(16)}}`)
    .join('')}]`,
  'u',
);

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const TITLE_SOURCES = ['libs/worker/read-models/src/lib', 'apps/api/src'];
// A milestone reference the form sends back and the route compares character for character (`expectedCurrent`,
// `expectedMilestone`): stripping it would break the comparison, and milestones are the owner's own.
const EXACT_MILESTONE_REFS: readonly string[] = ['apps/api/src/routes/sprint-commands.ts'];
const TITLE_FROM_RECORD = /^\s*title:\s*(?<value>.+?),?\s*$/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function issue(number: number, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number,
    title: HOSTILE,
    body: '',
    htmlUrl: `https://github.com/o/r/issues/${number}`,
    state: 'open',
    labels: ['kind:question'],
    authorAssociation: 'NONE',
    authorLogin: 'outsider',
    authorType: 'User',
    isPullRequest: false,
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const milestone: MilestoneRecord = {
  number: 3,
  title: `Sprint ${zwsp}03`,
  state: 'open',
  dueOn: '2026-10-16T00:00:00Z',
  htmlUrl: 'https://github.com/o/r/milestone/3',
};

const pull: PullRequestRecord = {
  number: 41,
  title: HOSTILE,
  htmlUrl: 'https://github.com/o/r/pull/41',
  draft: false,
  headSha: null,
  body: '',
  headRef: null,
  headRepo: null,
  authorAssociation: 'NONE',
  authorLogin: 'outsider',
  authorType: 'User',
};

/** Every value under a `title` key, at any depth. */
function titlesIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => titlesIn(item, found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'title' && typeof item === 'string') {
        found.push(item);
      } else {
        titlesIn(item, found);
      }
    }
  }
  return found;
}

function expectCleanTitles(dto: unknown, count: number): void {
  const titles = titlesIn(dto);
  expect(titles).toHaveLength(count);
  for (const title of titles) {
    expect(title).not.toMatch(INVISIBLE);
  }
}

describe('title hygiene (#287)', () => {
  it('the fixture titles do carry the characters the guard looks for', () => {
    expect(HOSTILE).toMatch(INVISIBLE);
    expect(milestone.title).toMatch(INVISIBLE);
  });

  it('every `title:` built from a GitHub record in the read models and the api routes goes through withoutInvisibles', () => {
    const offenders: string[] = [];
    for (const root of TITLE_SOURCES) {
      for (const file of sourceFiles(join(WORKSPACE, root))) {
        const path = relative(WORKSPACE, file);
        if (EXACT_MILESTONE_REFS.includes(path)) {
          continue;
        }
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            const value = TITLE_FROM_RECORD.exec(line)?.groups?.['value'];
            if (value !== undefined && /\.title\b/u.test(value) && !value.includes('withoutInvisibles(')) {
              offenders.push(`${path}:${index + 1}: ${line.trim()}`);
            }
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('inbox, questions and Needs you items', () => {
    const openIssues = [issue(1), issue(2, { labels: ['kind:question', 'owner:scope'] })];
    const inbox = buildInbox({ openIssues, reviewerLogins: ['r'], repoFullName: 'o/r' });
    expectCleanTitles(inbox, 2);
    expect(inbox.items.map((item) => item.title)).toEqual([CLEAN, CLEAN]);
    expectCleanTitles(buildQuestions(openIssues), 2);
    expectCleanTitles(needsOf(openIssues), 2);
    const needsYou = buildNeedsYou([{ project: { slug: 'p', name: 'P' }, inbox }], []);
    expectCleanTitles(needsYou, 2);
  });

  it('sprint issues, pull requests and the milestone', () => {
    const sprint = buildSprint({ milestone, milestoneIssues: [issue(40)], openPullRequests: [pull] });
    expectCleanTitles(sprint, 3);
    expect(sprint.milestone?.title).toBe('Sprint 03');
  });

  it('the overview row’s sprint', () => {
    const sprint = buildSprint({ milestone, milestoneIssues: [issue(40)], openPullRequests: [] });
    const row = buildOverviewRow({
      slug: 'p',
      name: 'P',
      team: 'running',
      inbox: buildInbox({ openIssues: [issue(1)], reviewerLogins: ['r'], repoFullName: 'o/r' }),
      // A sprint DTO handed over unstripped must still come out clean: the row strips on its own.
      sprint: { ...sprint, milestone: { ...sprint.milestone, title: milestone.title, number: 3, dueOn: '', url: null } },
      snooze: { snoozed: false },
    });
    expectCleanTitles(row, 1);
    expect(row.sprint?.title).toBe('Sprint 03');
  });

  it('demo and design artifacts made from issues', () => {
    const demos = demoArtifactsOf([issue(900, { labels: ['team:demo'] })]);
    expectCleanTitles(demos, 1);
    expect(demos[0]?.title).toBe(CLEAN);
    const designs = designArtifactsOf({
      issues: [issue(901, { labels: ['design:approved'] })],
      files: [],
      storybookUrl: null,
    });
    expectCleanTitles(designs, 1);
    expect(designs[0]?.title).toBe(CLEAN);
  });
});
