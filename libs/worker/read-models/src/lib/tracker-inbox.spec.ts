import { isItemKind, isItemStatus, type ItemKind } from '@shared/contracts';
import { ANSWERS, kindOf } from '@shared/owner-grammar';
import edgeCases from '../../fixtures/edge-cases.json';
import edgeCasesExpected from '../../fixtures/edge-cases.expected.json';
import storify from '../../fixtures/storify.json';
import storifyExpected from '../../fixtures/storify.expected.json';
import teamConsole from '../../fixtures/team-console.json';
import teamConsoleExpected from '../../fixtures/team-console.expected.json';
import { isGitHubIssue, issueRecordOf, type IssueRecord } from './github-records';
import { buildInbox } from './inbox';
import {
  buildTrackerInbox,
  buildTrackerQuestions,
  trackerInboxItemsOf,
  type TrackerInboxRow,
} from './tracker-inbox';
import { isTrustedAuthor } from './untrusted-text';

const COLUMN_PREFIXES = ['status:', 'kind:', 'tier:', 'sev:'];

/**
 * A GitHub issue as the import (Phase 1b) will turn it into a row: kind and status become columns, the other labels
 * flags, and the full label set is rebuilt the way `labelsOf` in the api builds it. A kind the tracker has no
 * column for reads as `chore` (neither is `question`, which is all `sectionOf` asks of the kind).
 */
function rowOf(issue: IssueRecord): TrackerInboxRow {
  const kindLabel = kindOf(issue.labels);
  const kind: ItemKind = isItemKind(kindLabel) ? kindLabel : 'chore';
  const statusLabel = issue.labels.find((name) => name.startsWith('status:'))?.slice('status:'.length);
  const status = isItemStatus(statusLabel) ? statusLabel : 'proposed';
  const flags = issue.labels.filter((name) => !COLUMN_PREFIXES.some((prefix) => name.startsWith(prefix)));
  return {
    key: `TC-${String(issue.number)}`,
    number: issue.number,
    kind,
    title: issue.title,
    body: issue.body,
    labels: [`status:${status}`, `kind:${kind}`, ...[...flags].sort()],
    createdByKind: isTrustedAuthor(issue) ? 'owner' : 'import',
    ask: null,
  };
}

function issuesOf(raw: readonly unknown[]): IssueRecord[] {
  return raw.filter(isGitHubIssue).map(issueRecordOf);
}

const CASES = [
  ['team-console', teamConsole.openIssues, teamConsoleExpected.inbox.items],
  ['storify', storify.openIssues, storifyExpected.inbox.items],
  ['edge-cases', edgeCases.openIssues, edgeCasesExpected.inbox.items],
] as const;

// Golden parity (#434): the same issues as rows give the same sections, order, categories and trust as the GitHub
// path and the plugin, so the two classifiers cannot drift.
describe.each(CASES)('rows of the golden fixture %s', (_name, raw, expected) => {
  const issues = issuesOf(raw);
  // Pull requests never become items.
  const rows = issues.filter((issue) => !issue.isPullRequest).map(rowOf);

  it('classify into the sections and order the plugin computes', () => {
    expect(buildTrackerInbox(rows).items.map((item) => [item.section, item.number])).toEqual(
      expected.map((item) => [item.section, item.number]),
    );
  });

  it('agree with the GitHub path on category and trust', () => {
    const shape = (item: { number: number; category: unknown; authorTrusted: boolean }) => [
      item.number,
      item.category,
      item.authorTrusted,
    ];
    const github = buildInbox({ openIssues: issues, reviewerLogins: ['x'], repoFullName: 'acme/x' });
    expect(buildTrackerInbox(rows).items.map(shape)).toEqual(github.items.map(shape));
  });
});

const ROW: TrackerInboxRow = {
  key: 'TC-7',
  number: 7,
  kind: 'question',
  title: 'Pay for the domain?​',
  body: '## Кратко\nДомен за $12 в год.',
  labels: ['status:proposed', 'kind:question', 'owner:scope'],
  createdByKind: 'job',
  ask: null,
};

describe('buildTrackerInbox', () => {
  it('fills the row fields: key, no url, the open ask as the answer line, its category and recommendation', () => {
    const inbox = buildTrackerInbox([
      {
        ...ROW,
        ask: {
          id: 41,
          ask: 'Approve $12?',
          category: 'money',
          commands: ['approve', 'reject'],
          recommended: 'approve',
        },
      },
    ]);
    expect(inbox).toEqual({
      items: [
        {
          section: 'question',
          number: 7,
          key: 'TC-7',
          askId: 41,
          title: 'Pay for the domain?',
          url: null,
          ask: 'Approve $12?',
          authorTrusted: true,
          category: 'money',
          recommendation: 'approve',
          context: expect.objectContaining({ structured: true, summary: 'Домен за $12 в год.' }) as unknown,
        },
      ],
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
    });
  });

  it('falls back to the owner:* label for the category and fails closed on a recommendation no batch takes', () => {
    const [item] = buildTrackerInbox([
      {
        ...ROW,
        ask: { id: 42, ask: 'Done?', category: 'access', commands: ['done', 'override'], recommended: 'done' },
      },
      { ...ROW, number: 8, key: 'TC-8' },
    ]).items;
    expect(item).toMatchObject({ category: 'access', recommendation: null });
    expect(buildTrackerInbox([{ ...ROW, number: 8, key: 'TC-8' }]).items[0]?.category).toBe('scope');
  });

  // #443 (security review of #442, finding 1): a job writes the ask, so it gets the titles' treatment (#287).
  it('strips invisible characters from the ask a job wrote, on the inbox and the questions', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const bom = String.fromCodePoint(0xfeff);
    const row: TrackerInboxRow = {
      ...ROW,
      ask: {
        id: 44,
        ask: `Approve ${rlo}21$${zwsp} for the ${bom}domain?`,
        category: 'money',
        commands: ['approve', 'reject'],
        recommended: 'approve',
      },
    };
    expect(buildTrackerInbox([row]).items[0]?.ask).toBe('Approve 21$ for the domain?');
    expect(buildTrackerQuestions([row]).items[0]?.ask).toBe('Approve 21$ for the domain?');
    expect(trackerInboxItemsOf([row])[0]?.item.ask).toBe('Approve 21$ for the domain?');
  });

  it('marks an imported row untrusted and never reads its body', () => {
    const [item] = buildTrackerInbox([{ ...ROW, createdByKind: 'import' }]).items;
    expect(item).toMatchObject({ authorTrusted: false, context: null });
  });

  it('leaves out rows no section takes and the plugin’s bookkeeping items, and orders by section then number', () => {
    const rows: TrackerInboxRow[] = [
      { ...ROW, number: 3, key: 'TC-3' },
      { ...ROW, number: 1, key: 'TC-1', kind: 'chore', labels: ['status:qa', 'kind:chore', 'team:demo'] },
      { ...ROW, number: 2, key: 'TC-2', kind: 'feature', labels: ['status:approved', 'kind:feature'] },
      {
        ...ROW,
        number: 4,
        key: 'TC-4',
        kind: 'chore',
        labels: ['kind:chore', 'team:run-log', 'needs:owner'],
      },
    ];
    expect(buildTrackerInbox(rows).items.map((item) => [item.section, item.number])).toEqual([
      ['release', 1],
      ['question', 3],
    ]);
  });
});

describe('trackerInboxItemsOf and buildTrackerQuestions', () => {
  it('take the open ask’s commands, else the section’s', () => {
    const rows: TrackerInboxRow[] = [
      { ...ROW, ask: { id: 43, ask: 'Approve?', category: 'scope', commands: ['approve'], recommended: null } },
      { ...ROW, number: 8, key: 'TC-8' },
    ];
    expect(trackerInboxItemsOf(rows).map(({ allowedCommands }) => allowedCommands)).toEqual([
      ['approve'],
      ANSWERS.question,
    ]);
    expect(buildTrackerQuestions(rows).items.map((item) => [item.body, item.allowedCommands])).toEqual([
      [ROW.body, ['approve']],
      [ROW.body, ANSWERS.question],
    ]);
  });
});
