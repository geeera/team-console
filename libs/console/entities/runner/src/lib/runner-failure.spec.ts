import { isRetryableRunnerFailure, type RunnerFailureKind } from './runner-failure';

describe('isRetryableRunnerFailure (#825)', () => {
  it.each<[RunnerFailureKind, string | null, boolean]>([
    ['offline', null, true],
    ['timeout', null, true],
    ['rate-limited', null, true],
    ['error', null, true],
    ['forbidden', 'runner-scope-enroller-only', false],
    ['forbidden', 'account-owner-only', false],
    ['invalid', 'allowed-projects-invalid', false],
    ['not-found', 'runner-not-found', false],
    ['revoked', 'runner-revoked', false],
    ['session-expired', null, false],
  ])('judges %s (%s) retryable: %s', (kind, slug, retryable) => {
    expect(isRetryableRunnerFailure({ kind, slug, field: null })).toBe(retryable);
  });
});
