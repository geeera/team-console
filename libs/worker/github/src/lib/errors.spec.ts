import {
  GitHubError,
  appNotInstalledError,
  mapGitHubResponse,
  ownerMismatchError,
  ownerNotConnectedError,
  requestBudgetError,
  retryAfterOf,
} from './errors';

const NOW = Date.parse('2026-09-30T12:00:00Z');

function reply(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('mapGitHubResponse (one test per row of the #9 table)', () => {
  it.each([401, 403])('%i without rate-limit headers → 503 github-auth', (status) => {
    const error = mapGitHubResponse(reply(status), NOW);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.problem).toMatchObject({ type: 'github-auth', status: 503 });
    expect(error.githubStatus).toBe(status);
  });

  it('403 with x-ratelimit-remaining: 0 → 429 with Retry-After until the reset', () => {
    const reset = String(Math.floor(NOW / 1000) + 90);
    const error = mapGitHubResponse(
      reply(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
      NOW,
    );
    expect(error.problem).toMatchObject({ type: 'github-rate-limit', status: 429, retryAfter: 90 });
  });

  it('403 with retry-after (secondary limit) → 429 with that Retry-After', () => {
    const error = mapGitHubResponse(reply(403, { 'retry-after': '42' }), NOW);
    expect(error.problem).toMatchObject({ type: 'github-rate-limit', status: 429, retryAfter: 42 });
  });

  it('429 without headers → 429 with the one-minute default', () => {
    expect(mapGitHubResponse(reply(429), NOW).problem).toMatchObject({
      type: 'github-rate-limit',
      status: 429,
      retryAfter: 60,
    });
  });

  it('404 → 404 github-not-found', () => {
    expect(mapGitHubResponse(reply(404), NOW).problem).toMatchObject({
      type: 'github-not-found',
      status: 404,
    });
  });

  it.each([500, 502, 503, 504])('%i → 502 github-unavailable', (status) => {
    expect(mapGitHubResponse(reply(status), NOW).problem).toMatchObject({
      type: 'github-unavailable',
      status: 502,
      detail: `GitHub answered ${status}`,
    });
  });

  it.each([400, 409, 410, 422])('%i → 502 github-unexpected with the status in detail', (status) => {
    expect(mapGitHubResponse(reply(status), NOW).problem).toMatchObject({
      type: 'github-unexpected',
      status: 502,
      detail: `GitHub answered ${status}`,
    });
  });
});

describe('retryAfterOf', () => {
  it('clamps a reset in the past to one second and a huge wait to an hour', () => {
    const past = String(Math.floor(NOW / 1000) - 10);
    expect(retryAfterOf(new Headers({ 'x-ratelimit-reset': past }), NOW)).toBe(1);
    expect(retryAfterOf(new Headers({ 'retry-after': '999999' }), NOW)).toBe(3600);
  });

  it('ignores a malformed header', () => {
    expect(retryAfterOf(new Headers({ 'retry-after': 'soon' }), NOW)).toBe(60);
  });
});

describe('appNotInstalledError', () => {
  it('is a 409 naming the repository', () => {
    expect(appNotInstalledError('geeera/team-console').problem).toEqual({
      type: 'github-app-not-installed',
      title: 'The console app is not installed on this repository',
      status: 409,
      detail: 'Install the team-console app on geeera/team-console',
    });
  });
});

describe('requestBudgetError', () => {
  it('is a 503 with no GitHub status: nothing was asked of GitHub', () => {
    const error = requestBudgetError();
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.githubStatus).toBeNull();
    expect(error.problem).toMatchObject({ type: 'github-request-budget', status: 503, retryAfter: 1 });
  });
});

describe('owner connection problems (ADR 0003 decisions 2(b) and 4)', () => {
  it('403 github-owner-not-connected carries connectUrl as an extension member, not as instance', () => {
    expect(ownerNotConnectedError().problem).toEqual({
      type: 'github-owner-not-connected',
      title: 'Connect GitHub to write as the owner',
      status: 403,
      extensions: { connectUrl: '/api/v1/github/connect' },
    });
  });

  it('409 github-owner-mismatch names the repository and its owner', () => {
    expect(ownerMismatchError('acme/site', 'acme').problem).toMatchObject({
      type: 'github-owner-mismatch',
      status: 409,
      detail: 'acme/site belongs to acme',
    });
  });
});
