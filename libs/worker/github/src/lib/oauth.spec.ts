import { json, scriptedGitHub } from '../testing/github-kit';
import { GitHubError } from './errors';
import { GITHUB_OAUTH_TOKEN_URL, GitHubOAuth, pkceChallengeOf } from './oauth';

// Assembled at run time so the repository's secret scanners never see a token-shaped literal.
const ACCESS = ['ghu', 'TESTSENTINELaccess'].join('_');
const REFRESH = ['ghr', 'TESTSENTINELrefresh'].join('_');
const CREDENTIALS = { clientId: 'Iv23liTESTCLIENT', clientSecret: 'client-secret-sentinel' };
const NOW = Date.parse('2026-09-30T12:00:00Z');
const NOW_S = NOW / 1000;

function oauthWith(handler: Parameters<typeof scriptedGitHub>[0]) {
  const github = scriptedGitHub(handler);
  return { github, oauth: new GitHubOAuth(CREDENTIALS, { fetch: github.fetch, now: () => NOW }) };
}

async function errorOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubError');
}

const ISSUED = {
  access_token: ACCESS,
  expires_in: 28_800,
  refresh_token: REFRESH,
  refresh_token_expires_in: 15_811_200,
  token_type: 'bearer',
  scope: '',
};

describe('pkceChallengeOf', () => {
  it('is base64url(SHA-256(verifier)) — the RFC 7636 appendix B example', async () => {
    await expect(pkceChallengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('GitHubOAuth.isConfigured', () => {
  it.each([
    [{ clientId: 'Iv23liABC', clientSecret: 's' }, true],
    [{ clientId: 'Iv1.0123abcd', clientSecret: 's' }, true],
    [{ clientId: '', clientSecret: 's' }, false],
    [{ clientId: 'Iv23liABC', clientSecret: '' }, false],
    [{ clientId: 'Iv23liABC' }, false],
    [{ clientId: 'https://evil.io', clientSecret: 's' }, false],
  ])('%o → %s', (credentials, expected) => {
    expect(GitHubOAuth.isConfigured(credentials)).toBe(expected);
  });
});

describe('GitHubOAuth.authorizeUrl', () => {
  it('is github.com/login/oauth/authorize with client_id, redirect_uri, state and an S256 challenge', () => {
    const { oauth } = oauthWith(() => json(500, {}));
    const url = new URL(
      oauth.authorizeUrl({
        redirectUri: 'https://tc.example/api/v1/github/callback',
        state: 'abc&x=1',
        codeChallenge: 'challenge',
      }),
    );
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CREDENTIALS.clientId,
      redirect_uri: 'https://tc.example/api/v1/github/callback',
      state: 'abc&x=1',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
  });
});

describe('GitHubOAuth.exchangeCode', () => {
  it('posts the code, verifier, redirect_uri and client credentials as a form to github.com, no redirects', async () => {
    const { github, oauth } = oauthWith(() => json(200, ISSUED));

    const result = await oauth.exchangeCode('the-code', 'the-verifier', 'https://tc.example/cb');

    expect(result).toEqual({
      kind: 'issued',
      pair: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        accessExpiresAt: NOW_S + 28_800,
        refreshExpiresAt: NOW_S + 15_811_200,
      },
    });
    const [call] = github.calls;
    expect(call?.url).toBe(GITHUB_OAUTH_TOKEN_URL);
    expect(call?.method).toBe('POST');
    expect(call?.redirect).toBe('manual');
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(Object.fromEntries(new URLSearchParams(call?.body ?? ''))).toEqual({
      client_id: CREDENTIALS.clientId,
      client_secret: CREDENTIALS.clientSecret,
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'https://tc.example/cb',
    });
  });

  it('reads the outcome from the JSON error field, not the status: a 200 with an error is refused', async () => {
    const { oauth } = oauthWith(() => json(200, { error: 'bad_verification_code', error_description: 'x' }));
    await expect(oauth.exchangeCode('c', 'v', 'r')).resolves.toEqual({
      kind: 'refused',
      error: 'bad_verification_code',
    });
  });

  it('keeps only a code-shaped error value (it is logged)', async () => {
    const { oauth } = oauthWith(() => json(400, { error: `bad ${ACCESS}` }));
    await expect(oauth.exchangeCode('c', 'v', 'r')).resolves.toEqual({ kind: 'refused', error: 'invalid' });
  });

  it.each([
    ['no refresh_token', { access_token: ACCESS, token_type: 'bearer' }],
    ['no expiries', { access_token: ACCESS, refresh_token: REFRESH }],
  ])(
    'a token with %s is non-expiring (the app setting is off), with the token to revoke',
    async (_label, body) => {
      const { oauth } = oauthWith(() => json(200, body));
      await expect(oauth.exchangeCode('c', 'v', 'r')).resolves.toEqual({
        kind: 'non-expiring',
        accessToken: ACCESS,
      });
    },
  );

  it.each([
    [
      'a 3xx',
      () => new Response(null, { status: 302, headers: { location: 'https://evil.io' } }),
      'github-unexpected',
    ],
    ['a 5xx', () => json(502, {}), 'github-unavailable'],
    [
      'a network failure',
      () => Promise.reject(new TypeError(`fetch failed ${CREDENTIALS.clientSecret}`)),
      'github-unavailable',
    ],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), 'github-unexpected'],
    ['a 200 without an access token', () => json(200, { token_type: 'bearer' }), 'github-unexpected'],
  ] as const)('%s is a GitHubError, never a success', async (_label, reply, type) => {
    const { github, oauth } = oauthWith(reply);
    const error = await errorOf(oauth.exchangeCode('c', 'v', 'r'));
    expect(error.problem.type).toBe(type);
    expect(JSON.stringify(error.problem)).not.toContain(CREDENTIALS.clientSecret);
    expect(github.calls).toHaveLength(1);
  });
});

describe('GitHubOAuth.refresh', () => {
  it('posts grant_type=refresh_token with the refresh token and returns the new pair', async () => {
    const { github, oauth } = oauthWith(() => json(200, ISSUED));
    await expect(oauth.refresh(REFRESH)).resolves.toMatchObject({ kind: 'issued' });
    expect(Object.fromEntries(new URLSearchParams(github.calls[0]?.body ?? ''))).toEqual({
      client_id: CREDENTIALS.clientId,
      client_secret: CREDENTIALS.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
    });
  });

  it('reports bad_refresh_token from the error field', async () => {
    const { oauth } = oauthWith(() => json(200, { error: 'bad_refresh_token' }));
    await expect(oauth.refresh(REFRESH)).resolves.toEqual({ kind: 'refused', error: 'bad_refresh_token' });
  });
});

describe('GitHubOAuth.fetchUser', () => {
  it('reads login and numeric id from GET /user with the fresh token', async () => {
    const { github, oauth } = oauthWith(() => json(200, { login: 'geeera', id: 1001, name: 'x' }));
    await expect(oauth.fetchUser(ACCESS)).resolves.toEqual({ login: 'geeera', id: 1001 });
    expect(github.calls[0]?.url).toBe('https://api.github.com/user');
    expect(github.calls[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
  });

  it.each([
    { login: 'a/b', id: 1 },
    { login: 'geeera', id: '1' },
    { login: 'geeera', id: 0 },
  ])('refuses a user of an unexpected shape: %o', async (body) => {
    const { oauth } = oauthWith(() => json(200, body));
    expect((await errorOf(oauth.fetchUser(ACCESS))).problem.type).toBe('github-unexpected');
  });

  it('maps a GitHub failure', async () => {
    const { oauth } = oauthWith(() => json(401, {}));
    expect((await errorOf(oauth.fetchUser(ACCESS))).problem.type).toBe('github-auth');
  });
});

describe('GitHubOAuth.revokeGrant', () => {
  it('DELETEs /applications/{client_id}/grant with Basic client credentials and the token in the body', async () => {
    const { github, oauth } = oauthWith(() => new Response(null, { status: 204 }));

    await expect(oauth.revokeGrant(ACCESS)).resolves.toBe('revoked');

    const [call] = github.calls;
    expect(call?.method).toBe('DELETE');
    expect(call?.url).toBe(`https://api.github.com/applications/${CREDENTIALS.clientId}/grant`);
    expect(call?.headers.get('authorization')).toBe(
      `Basic ${btoa(`${CREDENTIALS.clientId}:${CREDENTIALS.clientSecret}`)}`,
    );
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ access_token: ACCESS });
  });

  it('treats 404 as already gone', async () => {
    const { oauth } = oauthWith(() => json(404, {}));
    await expect(oauth.revokeGrant(ACCESS)).resolves.toBe('already-gone');
  });

  it.each([
    [502, 'github-unavailable'],
    [401, 'github-auth'],
    [422, 'github-unexpected'],
  ])('%i is a GitHubError (%s)', async (status, type) => {
    const { oauth } = oauthWith(() => json(status, {}));
    expect((await errorOf(oauth.revokeGrant(ACCESS))).problem.type).toBe(type);
  });
});
