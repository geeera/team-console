import { envelopeOf, type JsonObject } from '../github/payload';
import {
  issueCommentEvent,
  issuesEvent,
  pullRequestEvent,
  pushEvent,
  workflowRunEvent,
} from '../testing/payloads';
import { PM_REPLY_MARKER, deepLinkOf, mapEvent, settingsLinkOf, type MappedProject } from './map-event';

const project: MappedProject = { slug: 'storify', displayName: 'Storify', language: 'ru' };

function map(event: string, payload: JsonObject, target: MappedProject = project) {
  return mapEvent(target, event, envelopeOf(payload), payload);
}

describe('mapEvent — one test per row of the architect note', () => {
  it('row 1: issues.opened that needs the owner → decision push to the question', () => {
    const result = map('issues', issuesEvent('opened', { number: 42, labels: ['kind:question'] }));
    expect(result).toEqual({
      kind: 'push',
      message: {
        kind: 'decision',
        slug: 'storify',
        language: 'ru',
        title: 'Storify · нужно ваше решение',
        body: '#42 Pick the onboarding copy',
        url: '/p/storify/questions#42',
        tag: '/p/storify/questions#42',
      },
    });
  });

  it('row 1: issues.labeled when the added label is the one that made it need the owner', () => {
    const labeled = issuesEvent('labeled', { number: 9, labels: ['needs:owner'], addedLabel: 'needs:owner' });
    expect(map('issues', labeled)).toMatchObject({
      kind: 'push',
      message: { url: '/p/storify/questions#9' },
    });

    const alreadyWaiting = issuesEvent('labeled', {
      labels: ['needs:owner', 'priority:high'],
      addedLabel: 'priority:high',
    });
    expect(map('issues', alreadyWaiting)).toEqual({ kind: 'ignored', reason: 'no-notification' });
  });

  it('row 1: an issue that does not need the owner, or another action, maps to nothing', () => {
    expect(map('issues', issuesEvent('opened', { labels: ['kind:feature'] }))).toEqual({
      kind: 'ignored',
      reason: 'no-notification',
    });
    expect(map('issues', issuesEvent('closed', { labels: ['kind:question'] }))).toEqual({
      kind: 'ignored',
      reason: 'no-notification',
    });
  });

  it('row 2: issue_comment.created with the PM marker → "PM replied" to the chat', () => {
    const result = map('issue_comment', issueCommentEvent({ body: `${PM_REPLY_MARKER}\nHere is the plan.` }));
    expect(result).toMatchObject({
      kind: 'push',
      message: { kind: 'pm-reply', url: '/p/storify/chat', title: 'Storify · PM ответил' },
    });
  });

  it('row 3: a run-log comment whose first line says paused → "team paused" to the board', () => {
    const paused = issueCommentEvent({ labels: ['team:run-log'], body: '⏸ paused by owner\nreason: demo' });
    expect(map('issue_comment', paused)).toMatchObject({
      kind: 'push',
      message: { kind: 'team-paused', url: '/p/storify/board' },
    });

    const laterLine = issueCommentEvent({ labels: ['team:run-log'], body: 'started dev\nnot paused' });
    expect(map('issue_comment', laterLine)).toEqual({ kind: 'ignored', reason: 'no-notification' });
    const otherIssue = issueCommentEvent({ labels: ['kind:chore'], body: 'paused' });
    expect(map('issue_comment', otherIssue)).toEqual({ kind: 'ignored', reason: 'no-notification' });
  });

  it('row 4: the release PR into main opened or ready → go/no-go to the demo', () => {
    for (const action of ['opened', 'ready_for_review'] as const) {
      expect(map('pull_request', pullRequestEvent(action, { number: 77 }))).toMatchObject({
        kind: 'push',
        message: { kind: 'release-ready', url: '/p/storify/demo', body: '#77 Release 0.4.0' },
      });
    }
    expect(map('pull_request', pullRequestEvent('opened', { base: 'dev' }))).toEqual({
      kind: 'ignored',
      reason: 'no-notification',
    });
  });

  it('row 5: the deploy workflow failed → "deploy failed: <env>" to the board', () => {
    expect(map('workflow_run', workflowRunEvent({ branch: 'main' }))).toMatchObject({
      kind: 'push',
      message: { kind: 'deploy-failed', url: '/p/storify/board', title: 'Storify · деплой упал: production' },
    });
    expect(map('workflow_run', workflowRunEvent({ conclusion: 'success' }))).toEqual({
      kind: 'ignored',
      reason: 'no-notification',
    });
    expect(map('workflow_run', workflowRunEvent({ name: 'ci' }))).toEqual({
      kind: 'ignored',
      reason: 'no-notification',
    });
  });

  it('everything else maps to nothing', () => {
    expect(map('push', pushEvent('refs/heads/main'))).toEqual({ kind: 'ignored', reason: 'no-notification' });
  });

  it('writes the copy in the project language', () => {
    const result = map('issues', issuesEvent('opened', { labels: ['kind:question'] }), {
      ...project,
      language: 'en',
    });
    expect(result).toMatchObject({ message: { title: 'Storify · your decision is needed', language: 'en' } });
  });
});

describe('mapEvent — author gate (threat model row 4), one test per row', () => {
  const untrusted = { kind: 'ignored', reason: 'untrusted-author' };

  it('row 1: an outsider’s issue that needs the owner', () => {
    expect(map('issues', issuesEvent('opened', { labels: ['kind:question'], association: 'NONE' }))).toEqual(
      untrusted,
    );
  });

  it('row 2: an outsider’s comment carrying the PM marker', () => {
    const forged = issueCommentEvent({ body: PM_REPLY_MARKER, commentAssociation: 'NONE' });
    expect(map('issue_comment', forged)).toEqual(untrusted);
  });

  it('row 3: an outsider’s "paused" on the run log', () => {
    const forged = issueCommentEvent({
      labels: ['team:run-log'],
      body: 'paused',
      commentAssociation: 'CONTRIBUTOR',
    });
    expect(map('issue_comment', forged)).toEqual(untrusted);
  });

  it('row 4: an outsider’s PR into main', () => {
    expect(map('pull_request', pullRequestEvent('opened', { association: 'NONE' }))).toEqual(untrusted);
  });

  it('row 5: a deploy run from a fork', () => {
    expect(map('workflow_run', workflowRunEvent({ headRepo: 'stranger/storify' }))).toEqual(untrusted);
  });

  it('members and collaborators pass', () => {
    for (const association of ['MEMBER', 'COLLABORATOR'] as const) {
      expect(map('issues', issuesEvent('opened', { labels: ['kind:question'], association }))).toMatchObject({
        kind: 'push',
      });
    }
  });
});

describe('deep links', () => {
  it('are built from the slug and an integer only', () => {
    expect(deepLinkOf('storify', 'questions', 3)).toBe('/p/storify/questions#3');
    expect(settingsLinkOf('storify')).toBe('/settings/projects/storify');
    expect(() => deepLinkOf('../evil', 'chat')).toThrow();
    expect(() => settingsLinkOf('Evil/Slug')).toThrow();
  });
});
