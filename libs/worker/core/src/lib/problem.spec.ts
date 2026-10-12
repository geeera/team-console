import { problemBody } from './problem';

describe('problemBody', () => {
  it('builds the RFC 9457 body problem() answers with, for the given request', () => {
    expect(
      problemBody(
        {
          type: 'batch-not-safe',
          title: 'Not safe to approve in a batch',
          status: 422,
          detail: 'money',
          extensions: { reason: 'money' },
        },
        'req-1',
      ),
    ).toEqual({
      type: 'https://team-console/problems/batch-not-safe',
      title: 'Not safe to approve in a batch',
      status: 422,
      instance: 'req-1',
      detail: 'money',
      reason: 'money',
    });
  });

  it('leaves detail out when there is none', () => {
    expect(problemBody({ type: 'issue-closed', title: 'Closed', status: 409 }, 'r')).not.toHaveProperty(
      'detail',
    );
  });

  it('refuses an extension that would replace a standard member', () => {
    expect(() =>
      problemBody({ type: 'x', title: 'X', status: 400, extensions: { instance: 'forged' } }, 'r'),
    ).toThrow(/standard member "instance"/);
  });

  it('refuses a slug that is not one', () => {
    expect(() => problemBody({ type: 'Not A Slug', title: 'X', status: 400 }, 'r')).toThrow();
  });
});
