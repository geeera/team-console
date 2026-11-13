import {
  checkCreateAskInput,
  checkCreateDecisionInput,
  checkCreateRequestInput,
  checkHandleRequestInput,
  checkCreatePrLinkInput,
  checkCreateCommentInput,
  checkCreateItemInput,
  checkCreateLabelInput,
  checkCreateSprintInput,
  checkQueueMoveInput,
  checkUpdateItemInput,
  checkUpdateSprintInput,
} from './inputs';

const failure = (field: string) => ({ ok: false, field, detail: expect.any(String) as unknown });

describe('checkCreateItemInput', () => {
  it('fills the defaults and cleans the title', () => {
    expect(checkCreateItemInput({ title: '  ‮Fix login​ ', kind: 'bug' })).toEqual({
      ok: true,
      value: {
        title: 'Fix login',
        body: '',
        kind: 'bug',
        status: 'proposed',
        severity: null,
        tier: null,
        sprint: null,
        labels: [],
      },
    });
  });

  it('keeps the body as typed and de-duplicates flags', () => {
    const result = checkCreateItemInput({
      title: 'T',
      body: '  **as typed**\n',
      kind: 'feature',
      status: 'approved',
      severity: 'high',
      tier: 'heavy',
      sprint: 4,
      labels: ['security', 'security', 'needs-design'],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { body: '  **as typed**\n', sprint: 4, labels: ['security', 'needs-design'] },
    });
  });

  it.each([
    [[], 'body'],
    [{ kind: 'bug' }, 'title'],
    [{ title: '​ ‎', kind: 'bug' }, 'title'],
    [{ title: 'x'.repeat(257), kind: 'bug' }, 'title'],
    [{ title: '️', kind: 'bug' }, 'title'],
    [{ title: '⠀⠀', kind: 'bug' }, 'title'],
    [{ title: 'T', kind: 'epic' }, 'kind'],
    [{ title: 'T', kind: 'bug', status: 'done' }, 'status'],
    [{ title: 'T', kind: 'bug', body: 'x'.repeat(65_537) }, 'body'],
    [{ title: 'T', kind: 'bug', sprint: 0 }, 'sprint'],
    [{ title: 'T', kind: 'bug', labels: ['status:qa'] }, 'labels'],
    [{ title: 'T', kind: 'bug', labels: ['Bad Label'] }, 'labels'],
    [{ title: 'T', kind: 'bug', createdBy: 'pm' }, 'body'],
  ])('refuses %j at %s', (body, field) => {
    expect(checkCreateItemInput(body)).toEqual(failure(field));
  });

  it('counts the title in characters, not UTF-16 units', () => {
    expect(checkCreateItemInput({ title: '😀'.repeat(256), kind: 'bug' }).ok).toBe(true);
  });

  // #470 item 5, round 2: a variation selector or a ZWJ sequence attached to real content is kept, never stripped.
  it('keeps a variation selector or a ZWJ sequence attached to real content', () => {
    expect(checkCreateItemInput({ title: 'Favorites ❤️', kind: 'bug' })).toMatchObject({
      ok: true,
      value: { title: 'Favorites ❤️' },
    });
    expect(checkCreateItemInput({ title: '🏳️‍🌈', kind: 'bug' })).toMatchObject({
      ok: true,
      value: { title: '🏳️‍🌈' },
    });
  });
});

describe('checkUpdateItemInput', () => {
  it('takes only the members it is given, null clearing severity, tier and sprint', () => {
    expect(checkUpdateItemInput({ status: 'qa', severity: null, sprint: null })).toEqual({
      ok: true,
      value: { status: 'qa', severity: null, sprint: null },
    });
  });

  it('closes with a reason', () => {
    expect(checkUpdateItemInput({ state: 'closed', closedReason: 'duplicate' })).toMatchObject({ ok: true });
  });

  it.each([
    [{}, 'body'],
    [{ title: null }, 'title'],
    [{ state: 'closed' }, 'closedReason'],
    [{ closedReason: 'not-planned' }, 'closedReason'],
    [{ state: 'closed', closedReason: 'done' }, 'closedReason'],
    [{ state: 'closed', closedReason: 'duplicate', status: 'done' }, 'state'],
    [{ addLabels: ['security'], removeLabels: ['security'] }, 'removeLabels'],
    [{ version: 3 }, 'body'],
  ])('refuses %j at %s', (body, field) => {
    expect(checkUpdateItemInput(body)).toEqual(failure(field));
  });
});

describe('sprint, comment and label inputs', () => {
  it('checks a sprint', () => {
    expect(checkCreateSprintInput({ dueOn: '2026-11-17' })).toEqual({
      ok: true,
      value: { dueOn: '2026-11-17', description: '', title: null },
    });
    expect(checkCreateSprintInput({ dueOn: '2026-02-30' })).toEqual(failure('dueOn'));
    expect(checkCreateSprintInput({ title: ' \u2066Q4\tpush\u2069 ' })).toMatchObject({
      ok: true,
      value: { title: 'Q4 push' },
    });
    expect(checkCreateSprintInput({ title: 'x'.repeat(256) })).toMatchObject({ ok: true });
    expect(checkCreateSprintInput({ title: 'x'.repeat(257) })).toEqual(failure('title'));
    expect(checkCreateSprintInput({ title: '\u200b' })).toEqual(failure('title'));
    expect(checkCreateSprintInput({ title: '\ufe0f' })).toEqual(failure('title'));
    expect(checkCreateSprintInput({ title: '\u2800\u2800' })).toEqual(failure('title'));
    expect(checkCreateSprintInput({ title: ['Sprint 01'] })).toEqual(failure('title'));
    expect(checkUpdateSprintInput({ state: 'closed', dueOn: null })).toEqual({
      ok: true,
      value: { state: 'closed', dueOn: null },
    });
    expect(checkUpdateSprintInput({ state: 'done' })).toEqual(failure('state'));
    expect(checkUpdateSprintInput({})).toEqual(failure('body'));
  });

  it('checks a comment', () => {
    expect(checkCreateCommentInput({ body: 'Looks good' })).toEqual({
      ok: true,
      value: { kind: 'comment', body: 'Looks good' },
    });
    expect(checkCreateCommentInput({ body: '  \n' })).toEqual(failure('body'));
    expect(checkCreateCommentInput({ body: 'x', author: 'owner' })).toEqual(failure('body'));
  });

  it('checks a comment kind (#444): comment by default, note or decision when named, nothing else', () => {
    expect(checkCreateCommentInput({ kind: 'note', body: 'x' })).toEqual({
      ok: true,
      value: { kind: 'note', body: 'x' },
    });
    expect(checkCreateCommentInput({ kind: 'decision', body: 'x' })).toEqual({
      ok: true,
      value: { kind: 'decision', body: 'x' },
    });
    for (const kind of ['verdict', 'approve', '', null, 1]) {
      expect(checkCreateCommentInput({ kind, body: 'x' })).toEqual(failure('kind'));
    }
  });

  it('checks a custom label', () => {
    expect(checkCreateLabelInput({ name: 'agent:dev', color: 'ededed' })).toEqual({
      ok: true,
      value: { name: 'agent:dev', color: 'ededed', description: '' },
    });
    expect(checkCreateLabelInput({ name: 'tier:huge', color: 'ededed' })).toEqual(failure('name'));
    expect(checkCreateLabelInput({ name: 'x', color: '#EDEDED' })).toEqual(failure('color'));
  });
});

// #434: asks, decisions and requests. Server-owned members are refused by name; any other unknown member names the body.
const FORGED = [
  'author',
  'authorKind',
  'jobId',
  'decidedAt',
  'projectSlug',
  'itemId',
  'handledByJobId',
  'requestedAt',
  'source',
] as const;

describe('checkCreateAskInput', () => {
  const ask = { category: 'scope', ask: 'Ship now?', commands: ['approve', 'reject'] };

  it('accepts an ask and defaults the recommendation to null', () => {
    expect(checkCreateAskInput(ask)).toEqual({ ok: true, value: { ...ask, recommended: null } });
    expect(checkCreateAskInput({ ...ask, recommended: 'reject' })).toMatchObject({
      ok: true,
      value: { recommended: 'reject' },
    });
  });

  it.each([
    [{ ...ask, category: 'taste' }, 'category'],
    [{ ...ask, ask: '' }, 'ask'],
    [{ ...ask, ask: '  ' }, 'ask'],
    [{ ...ask, ask: 'x'.repeat(2049) }, 'ask'],
    [{ ...ask, commands: [] }, 'commands'],
    [{ ...ask, commands: ['approve', 'resume'] }, 'commands'],
    [{ ...ask, commands: ['approve', 'approve'] }, 'commands'],
    [{ ...ask, commands: 'approve' }, 'commands'],
    [{ ...ask, recommended: 'go' }, 'recommended'],
    [{ ...ask, kind: 'question' }, 'body'],
    [[], 'body'],
  ])('refuses %j on %s', (body, field) => {
    expect(checkCreateAskInput(body)).toEqual(failure(field));
  });

  it.each(FORGED)('names the forged member %s', (member) => {
    expect(checkCreateAskInput({ ...ask, [member]: 'x' })).toEqual(failure(member));
  });
});

describe('checkCreateDecisionInput', () => {
  it('accepts a decision with its defaults', () => {
    expect(checkCreateDecisionInput({ command: 'approve', via: 'web' })).toEqual({
      ok: true,
      value: { command: 'approve', text: '', askId: null, reversesCommentId: null, via: 'web' },
    });
    expect(
      checkCreateDecisionInput({
        command: 'reject',
        text: 'No',
        askId: 3,
        reversesCommentId: 9,
        via: 'push',
      }),
    ).toMatchObject({ ok: true, value: { askId: 3, reversesCommentId: 9, via: 'push' } });
  });

  it.each([
    [{ command: 'merge', via: 'web' }, 'command'],
    [{ command: 'approve', via: 'import' }, 'via'],
    [{ command: 'approve' }, 'via'],
    [{ command: 'approve', via: 'web', text: 'x'.repeat(2001) }, 'text'],
    [{ command: 'approve', via: 'web', askId: 0 }, 'askId'],
    [{ command: 'approve', via: 'web', askId: '3' }, 'askId'],
    [{ command: 'approve', via: 'web', reversesCommentId: 1.5 }, 'reversesCommentId'],
    [{ command: 'approve', via: 'web', ownerSaid: 'yes' }, 'body'],
  ])('refuses %j on %s', (body, field) => {
    expect(checkCreateDecisionInput(body)).toEqual(failure(field));
  });

  it.each(FORGED)('names the forged member %s', (member) => {
    expect(checkCreateDecisionInput({ command: 'approve', via: 'web', [member]: 'x' })).toEqual(
      failure(member),
    );
  });
});

describe('checkCreateRequestInput', () => {
  it('accepts exactly the owner request shapes', () => {
    expect(checkCreateRequestInput({ kind: 'sprint', target: 'next' })).toEqual({
      ok: true,
      value: { kind: 'sprint', target: 'next' },
    });
    expect(checkCreateRequestInput({ kind: 'priority', direction: 'down' })).toMatchObject({ ok: true });
  });

  it.each([
    [{ kind: 'label', target: 'next' }, 'kind'],
    [{ kind: 'sprint', target: 'later' }, 'target'],
    [{ kind: 'sprint', target: 'next', direction: 'up' }, 'target'],
    [{ kind: 'priority', direction: 'sideways' }, 'direction'],
    [{ kind: 'sprint', target: 'next', milestone: 'S1' }, 'body'],
  ])('refuses %j on %s', (body, field) => {
    expect(checkCreateRequestInput(body)).toEqual(failure(field));
  });

  it.each(FORGED)('names the forged member %s', (member) => {
    expect(checkCreateRequestInput({ kind: 'sprint', target: 'next', [member]: 'x' })).toEqual(
      failure(member),
    );
  });
});

describe('checkHandleRequestInput', () => {
  it('accepts the answer and defaults the reason to empty', () => {
    expect(checkHandleRequestInput({ result: 'applied' })).toEqual({
      ok: true,
      value: { result: 'applied', reason: '' },
    });
  });

  it.each([
    [{ result: 'done' }, 'result'],
    [{ result: 'declined', reason: 'x'.repeat(1025) }, 'reason'],
    [{ result: 'declined', handledBy: 'pm' }, 'body'],
    [{ result: 'declined', handledByJobId: 'job-1' }, 'handledByJobId'],
  ])('refuses %j on %s', (body, field) => {
    expect(checkHandleRequestInput(body)).toEqual(failure(field));
  });
});

describe('checkCreatePrLinkInput', () => {
  const url = 'https://github.com/acme/shop/pull/57';

  it('accepts a pull request of the given number', () => {
    expect(checkCreatePrLinkInput({ number: 57, url, headRef: 'feature/tc-12-login' })).toEqual({
      ok: true,
      value: { number: 57, url, headRef: 'feature/tc-12-login' },
    });
  });

  it.each([
    [{ url, headRef: 'x' }, 'number'],
    [{ number: 0, url, headRef: 'x' }, 'number'],
    [{ number: 5.5, url, headRef: 'x' }, 'number'],
    [{ number: '57', url, headRef: 'x' }, 'number'],
    [{ number: 2_147_483_648, url: 'https://github.com/a/b/pull/2147483648', headRef: 'x' }, 'number'],
    [{ number: 58, url, headRef: 'x' }, 'url'],
    [{ number: 57, url: 'http://github.com/acme/shop/pull/57', headRef: 'x' }, 'url'],
    [{ number: 57, url: 'https://github.com.evil.example/acme/shop/pull/57', headRef: 'x' }, 'url'],
    [{ number: 57, url: 'https://github.com/acme/shop/pull/57?x=1', headRef: 'x' }, 'url'],
    [{ number: 57, url: 'https://github.com/acme/shop/issues/57', headRef: 'x' }, 'url'],
    [{ number: 57, url: `https://github.com/acme/${'s'.repeat(512)}/pull/57`, headRef: 'x' }, 'url'],
    [{ number: 57, url, headRef: '' }, 'headRef'],
    [{ number: 57, url, headRef: 'x'.repeat(256) }, 'headRef'],
    [{ number: 57, url }, 'headRef'],
    [{ number: 57, url, headRef: 'x', linkedAt: '2026-01-01' }, 'body'],
    [{ number: 57, url, headRef: 'x', jobId: 'job-forged' }, 'jobId'],
    [[], 'body'],
  ])('refuses %j (field %s)', (body, field) => {
    expect(checkCreatePrLinkInput(body)).toEqual(failure(field));
  });
});

describe('checkQueueMoveInput', () => {
  it('takes exactly one of first, up or down and refuses anything else', () => {
    expect(checkQueueMoveInput({ move: 'first' })).toEqual({ ok: true, value: { move: 'first' } });
    expect(checkQueueMoveInput({ move: 'down' })).toEqual({ ok: true, value: { move: 'down' } });
    expect(checkQueueMoveInput({ move: 'before', key: 'TC-3' })).toEqual(failure('body'));
    expect(checkQueueMoveInput({ move: 'top' })).toEqual(failure('move'));
    expect(checkQueueMoveInput({})).toEqual(failure('move'));
    expect(checkQueueMoveInput(undefined)).toEqual(failure('body'));
  });
});
