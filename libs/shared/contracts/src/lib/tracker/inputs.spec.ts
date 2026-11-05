import {
  checkCreateCommentInput,
  checkCreateItemInput,
  checkCreateLabelInput,
  checkCreateSprintInput,
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
      value: { dueOn: '2026-11-17', description: '' },
    });
    expect(checkCreateSprintInput({ dueOn: '2026-02-30' })).toEqual(failure('dueOn'));
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
      value: { body: 'Looks good' },
    });
    expect(checkCreateCommentInput({ body: '  \n' })).toEqual(failure('body'));
    expect(checkCreateCommentInput({ body: 'x', kind: 'decision' })).toEqual(failure('body'));
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
