import { VcsError, mapVcsError, vcsWriteForbidden } from './errors';
import { isPullRequestState } from './types';

describe('vcsWriteForbidden', () => {
  it('is a 403 vcs-write-forbidden naming the operation, kind forbidden', () => {
    const error = vcsWriteForbidden('pullRequests.merge');
    expect(error).toBeInstanceOf(VcsError);
    expect(error.kind).toBe('forbidden');
    expect(error.problem).toEqual({
      type: 'vcs-write-forbidden',
      title: 'Repository writes are not enabled',
      status: 403,
      detail: 'pullRequests.merge is not available yet',
    });
    expect(error.message).toBe('Repository writes are not enabled');
  });
});

describe('mapVcsError', () => {
  it('answers a VcsError with its problem and logs the kind and provider status only', () => {
    const error = new VcsError(
      'rate-limited',
      { type: 'github-rate-limit', title: 'GitHub rate limit reached', status: 429, retryAfter: 30 },
      403,
    );
    expect(error.retryAfter).toBe(30);
    expect(mapVcsError(error)).toEqual({
      problem: error.problem,
      logFields: { vcsKind: 'rate-limited', providerStatus: 403 },
    });
  });

  it('leaves every other error to the next mapper', () => {
    expect(mapVcsError(new Error('boom'))).toBeUndefined();
    expect(mapVcsError('text')).toBeUndefined();
  });
});

describe('isPullRequestState', () => {
  it('accepts the three states only', () => {
    expect(['open', 'closed', 'merged'].every(isPullRequestState)).toBe(true);
    expect(isPullRequestState('all')).toBe(false);
    expect(isPullRequestState(1)).toBe(false);
  });
});
