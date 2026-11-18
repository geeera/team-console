import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { pkceChallengeOf } from '@worker/github';
import { ApiGitHub } from '../github';
import { callbackUrlFor } from './github-connection';
import { openAttemptCookie, sealAttemptCookie } from '../owner/oauth-cookie';
import { loadOwnerKeys } from '../owner/owner-keys';
import {
  OWNER as OWNER_EMAIL,
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import type { FakeGitHubOAuth } from '@worker/github/testing';
import { localEnv } from '../testing/github-kit';
import {
  ENVIRONMENT,
  OWNER,
  fakeGitHub,
  ownerConnection,
  parsedLogs,
  resetOwnerConnections,
  seedConnection,
  storedRow,
} from '../testing/owner-kit';

// #59 (ADR 0003 decision 3; threat model on #59, rows 1–11): the owner connection routes, end to end through the
// Worker with the fake GitHub standing in for github.com and api.github.com.

const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const CALLBACK_URI = 'http://api.test/api/v1/github/callback';
const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const CLEARED = `__Host-tc_oauth=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;

interface Harness {
  readonly fake: FakeGitHubOAuth;
  readonly github: ApiGitHub;
  readonly logs: string[];
}

function harness(fake: FakeGitHubOAuth = fakeGitHub()): Harness {
  return { fake, github: new ApiGitHub({ fetch: fake.fetch }), logs: [] };
}

async function call(
  h: Harness,
  path: string,
  init: { method?: string; headers?: Record<string, string>; bindings?: ReturnType<typeof localEnv> } = {},
): Promise<Response> {
  return fetchApi(path, init.bindings ?? localEnv(), {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    github: h.github,
    logSink: (line) => h.logs.push(line),
  });
}

interface Started {
  readonly authorizeUrl: URL;
  /** `__Host-tc_oauth=<sealed>`, as the browser sends it back. */
  readonly cookie: string;
  readonly setCookie: string;
}

async function startConnect(h: Harness, headers: Record<string, string> = {}): Promise<Started> {
  const response = await call(h, '/api/v1/github/connect', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, ...headers },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorizeUrl: string };
  const setCookie = response.headers.get('set-cookie') ?? '';
  return { authorizeUrl: new URL(body.authorizeUrl), cookie: setCookie.split(';')[0] ?? '', setCookie };
}

async function callback(h: Harness, query: string, cookie?: string): Promise<Response> {
  return call(
    h,
    `/api/v1/github/callback?${query}`,
    cookie === undefined ? {} : { headers: { Cookie: cookie } },
  );
}

/** Connect → GitHub authorizes as `user` → callback; returns the callback's answer and what it was called with. */
async function connectAs(
  h: Harness,
  user = OWNER,
): Promise<{ response: Response; started: Started; query: string }> {
  const started = await startConnect(h);
  const code = h.fake.authorize(started.authorizeUrl.href, user);
  const query = new URLSearchParams({
    code,
    state: started.authorizeUrl.searchParams.get('state') ?? '',
  }).toString();
  return { response: await callback(h, query, started.cookie), started, query };
}

function expectBackToSettings(response: Response, location: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(location);
  expect(response.headers.get('set-cookie')).toBe(CLEARED);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('cache-control')).toBe('no-store');
  // #126: the callback's own Referrer-Policy stays, and createWorkerApp adds nosniff/CSP on top of it.
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
}

async function problemSlug(response: Response): Promise<string | null> {
  const body: unknown = await response.json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

/** `DELETE /applications/{id}/{grant|token}` calls the fake saw, in order. */
function revokeCalls(h: Harness): string[] {
  return h.fake.calls
    .filter((c) => c.method === 'DELETE' && new URL(c.url).pathname.startsWith('/applications/'))
    .map((c) => `${c.method} ${new URL(c.url).pathname}`);
}

/** D1 that refuses to store an owner connection, as an outage between the exchange and the write would. */
function failingOwnerInserts(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (sql.includes('INSERT INTO owner_connections')) {
            throw new Error('D1 is unavailable');
          }
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await resetOwnerConnections();
});

describe('POST /api/v1/github/connect', () => {
  it('answers the GitHub authorize URL and sets the sealed __Host-tc_oauth cookie (A1: Path=/)', async () => {
    const h = harness();
    const response = await call(h, '/api/v1/github/connect', { method: 'POST', headers: SAME_ORIGIN });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'state'].sort(),
    );
    expect(url.searchParams.get('client_id')).toBe(env.GITHUB_APP_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // 256 random bits (≥ 128 asked by threat row 3).
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(
      /^__Host-tc_oauth=[0-9a-f]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(setCookie).not.toContain('Domain');

    // The cookie holds this state and the verifier behind this challenge, sealed under the oauth-state subkey.
    const keys = await loadOwnerKeys(env.TOKEN_ENCRYPTION_KEY, ENVIRONMENT);
    const opened = await openAttemptCookie(
      keys.stateKey,
      ENVIRONMENT,
      setCookie.split(';')[0]?.split('=')[1],
      Date.now(),
    );
    if (!opened.ok) {
      throw new Error(`cookie did not open: ${opened.reason}`);
    }
    expect(opened.attempt.state).toBe(url.searchParams.get('state'));
    expect(await pkceChallengeOf(opened.attempt.verifier)).toBe(url.searchParams.get('code_challenge'));
    expect(h.fake.calls).toEqual([]);
  });

  it('builds redirect_uri from the routed URL, never from a spoofed Host or X-Forwarded-Host header', async () => {
    const started = await startConnect(harness(), {
      Host: 'evil.example',
      'X-Forwarded-Host': 'evil.example',
    });
    expect(started.authorizeUrl.searchParams.get('redirect_uri')).toBe(CALLBACK_URI);
  });

  it('uses https for redirect_uri outside a local run, whatever scheme reached the Worker', () => {
    expect(callbackUrlFor('http://team-console-dev.acct.workers.dev/api/v1/github/connect', 'dev')).toBe(
      'https://team-console-dev.acct.workers.dev/api/v1/github/callback',
    );
    expect(callbackUrlFor('http://localhost:8787/api/v1/github/connect', 'local')).toBe(
      'http://localhost:8787/api/v1/github/callback',
    );
  });

  it.each([
    ['no client secret', { GITHUB_APP_CLIENT_SECRET: '' }],
    ['no client id', { GITHUB_APP_CLIENT_ID: '' }],
    ['no owner login', { OWNER_GITHUB_LOGIN: '' }],
    ['a 31-byte master key', { TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(31)) }],
    ['a 33-byte master key', { TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(33)) }],
  ])('with %s → 503 github-auth and no cookie', async (_label, overrides) => {
    const h = harness();
    const response = await call(h, '/api/v1/github/connect', {
      method: 'POST',
      headers: SAME_ORIGIN,
      bindings: localEnv(overrides),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await problemSlug(response)).toBe('github-auth');
  });
});

describe('CSRF on connect and disconnect (threat row 2)', () => {
  it.each([
    ['a cross-site Origin', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }, 403],
    ['no Origin and Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['a text/plain body', { ...SAME_ORIGIN, 'Content-Type': 'text/plain' }, 415],
  ])('%s → refused; connect sets no cookie, disconnect deletes nothing', async (_label, headers, status) => {
    const h = harness();
    await seedConnection(h.fake);

    const connect = await call(h, '/api/v1/github/connect', { method: 'POST', headers });
    const disconnect = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers });

    expect([connect.status, disconnect.status]).toEqual([status, status]);
    expect(connect.headers.get('set-cookie')).toBeNull();
    expect(await storedRow()).not.toBeNull();
    expect(h.fake.calls).toEqual([]);
  });
});

describe('Access in front of every #59 route (threat row 1)', () => {
  it.each([
    ['POST', '/api/v1/github/connect'],
    ['GET', '/api/v1/github/callback?code=abc&state=def'],
    ['GET', '/api/v1/github/connection'],
    ['DELETE', '/api/v1/github/connection'],
  ])('%s %s without an Access JWT → 401, no GitHub call, no cookie set or consumed', async (method, path) => {
    const h = harness();
    await seedConnection(h.fake);
    const response = await call(h, path, {
      method,
      headers: { ...SAME_ORIGIN, Cookie: '__Host-tc_oauth=00' },
      bindings: accessEnv(uniqueTeamDomain()),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(h.fake.calls).toEqual([]);
    expect(await storedRow()).not.toBeNull();
  });
});

describe('the CI service token is refused on every #59 route (#85)', () => {
  const ROUTES = [
    ['POST', '/api/v1/github/connect'],
    ['GET', '/api/v1/github/callback?code=abc&state=def'],
    ['GET', '/api/v1/github/connection'],
    ['DELETE', '/api/v1/github/connection'],
  ] as const;

  async function signedEnv(claims: Record<string, unknown>) {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    return {
      bindings: accessEnv(teamDomain, { ENVIRONMENT: 'dev' }),
      token: await signAccessToken(key, teamDomain, { claims }),
    };
  }

  it.each(ROUTES)(
    '%s %s with the service identity → 403 owner-only, no GitHub call, row and cookie untouched',
    async (method, path) => {
      const h = harness();
      await seedConnection(h.fake);
      const before = await storedRow();
      const { bindings, token } = await signedEnv({ email: undefined, common_name: SERVICE_TOKEN_ID });

      const response = await call(h, path, {
        method,
        bindings,
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          Origin: 'http://api.test',
          Cookie: '__Host-tc_oauth=00',
        },
      });

      expect(response.status).toBe(403);
      expect(await problemSlug(response)).toBe('owner-only');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(h.fake.calls).toEqual([]);
      expect(await storedRow()).toEqual(before);
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({ message: 'owner route refused', reason: 'service' }),
      );
    },
  );

  it('the owner (a user identity) passes the same way', async () => {
    const h = harness();
    const { bindings, token } = await signedEnv({ email: OWNER_EMAIL });
    const response = await call(h, '/api/v1/github/connection', {
      bindings,
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(response.status).toBe(200);
  });
});

describe('GET /api/v1/github/callback', () => {
  it('connects the owner: stores the pair with the numeric user id and redirects to Settings', async () => {
    const h = harness();
    const { response } = await connectAs(h);

    expectBackToSettings(response, '/settings?github=connected');
    const row = await storedRow();
    expect(row).toMatchObject({ environment: ENVIRONMENT, login: 'geeera', user_id: 1001, version: 1 });
    expect(Number.isInteger(row?.user_id)).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/gh[ur]_/);
    expect(h.fake.activeGrants()).toBe(1);
    expect(parsedLogs(h.logs).some((line) => line['message'] === 'owner connected')).toBe(true);
  });

  it('accepts the owner login in another case', async () => {
    const h = harness();
    const { response } = await connectAs(h, { login: 'GeeEra', id: 1001 });
    expectBackToSettings(response, '/settings?github=connected');
    expect(await storedRow()).toMatchObject({ login: 'GeeEra', user_id: 1001 });
  });

  // Decision 4, named test 5; threat row 5.
  it('refuses any other login: revokes the fresh grant first, logs a security warning, stores nothing', async () => {
    const h = harness();
    const { response } = await connectAs(h, { login: 'stranger', id: 2002 });

    expectBackToSettings(response, '/settings?github=wrong-account&login=stranger');
    expect(await storedRow()).toBeNull();
    expect(h.fake.activeGrants()).toBe(0);
    const revokeIndex = h.fake.calls.findIndex((c) => c.method === 'DELETE');
    expect(h.fake.calls[revokeIndex]?.url).toBe(
      `https://api.github.com/applications/${env.GITHUB_APP_CLIENT_ID}/grant`,
    );
    expect(revokeIndex).toBe(h.fake.calls.length - 1);
    expect(parsedLogs(h.logs)).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        securitySignal: 'owner-login-refused',
        login: 'stranger',
        revoked: true,
      }),
    );
  });

  it('GitHub access_denied → back to Settings as denied, cookie cleared, no GitHub call', async () => {
    const h = harness();
    const started = await startConnect(h);
    const state = started.authorizeUrl.searchParams.get('state') ?? '';

    const response = await callback(h, `error=access_denied&state=${state}`, started.cookie);

    expectBackToSettings(response, '/settings?github=denied');
    expect(h.fake.calls).toEqual([]);
  });

  describe('refused before any GitHub call, nothing stored, cookie cleared (threat row 4)', () => {
    async function expectRefused(h: Harness, response: Response): Promise<void> {
      expectBackToSettings(response, '/settings?github=failed');
      expect(h.fake.calls.filter((c) => !c.url.endsWith('/authorize'))).toEqual([]);
      expect(await storedRow()).toBeNull();
    }

    async function codeAndState(h: Harness): Promise<{ started: Started; code: string; state: string }> {
      const started = await startConnect(h);
      return {
        started,
        code: h.fake.authorize(started.authorizeUrl.href),
        state: started.authorizeUrl.searchParams.get('state') ?? '',
      };
    }

    it('no cookie', async () => {
      const h = harness();
      const { code, state } = await codeAndState(h);
      await expectRefused(h, await callback(h, `code=${code}&state=${state}`));
    });

    it('a tampered cookie (one bit flipped)', async () => {
      const h = harness();
      const { started, code, state } = await codeAndState(h);
      const last = started.cookie.endsWith('0') ? '1' : '0';
      await expectRefused(
        h,
        await callback(h, `code=${code}&state=${state}`, `${started.cookie.slice(0, -1)}${last}`),
      );
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({ reason: 'cookie-unreadable', securitySignal: 'owner-connect-tampered' }),
      );
    });

    it('a cookie older than 600 s (the sealed iat, not Max-Age)', async () => {
      const h = harness();
      const { code, state, started } = await codeAndState(h);
      const keys = await loadOwnerKeys(env.TOKEN_ENCRYPTION_KEY, ENVIRONMENT);
      const cookieKeys = await openAttemptCookie(
        keys.stateKey,
        ENVIRONMENT,
        started.cookie.split('=')[1],
        Date.now(),
      );
      if (!cookieKeys.ok) {
        throw new Error('cookie did not open');
      }
      const stale = await sealAttemptCookie(keys.stateKey, ENVIRONMENT, {
        ...cookieKeys.attempt,
        issuedAt: Date.now() - 601_000,
      });
      await expectRefused(h, await callback(h, `code=${code}&state=${state}`, stale.split(';')[0]));
      expect(parsedLogs(h.logs)).toContainEqual(expect.objectContaining({ reason: 'cookie-expired' }));
    });

    it('a cookie sealed for another environment (other HKDF salt and AAD)', async () => {
      const h = harness();
      const { code, state, started } = await codeAndState(h);
      const local = await loadOwnerKeys(env.TOKEN_ENCRYPTION_KEY, ENVIRONMENT);
      const opened = await openAttemptCookie(
        local.stateKey,
        ENVIRONMENT,
        started.cookie.split('=')[1],
        Date.now(),
      );
      if (!opened.ok) {
        throw new Error('cookie did not open');
      }
      const stage = await loadOwnerKeys(env.TOKEN_ENCRYPTION_KEY, 'stage');
      const foreign = await sealAttemptCookie(stage.stateKey, 'stage', opened.attempt);
      await expectRefused(h, await callback(h, `code=${code}&state=${state}`, foreign.split(';')[0]));
    });

    it('a mismatched state', async () => {
      const h = harness();
      const { started, code } = await codeAndState(h);
      await expectRefused(h, await callback(h, `code=${code}&state=${'a'.repeat(64)}`, started.cookie));
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({ reason: 'state-mismatch', securitySignal: 'owner-connect-tampered' }),
      );
    });

    it('a missing code', async () => {
      const h = harness();
      const { started, state } = await codeAndState(h);
      await expectRefused(h, await callback(h, `state=${state}`, started.cookie));
    });
  });

  it('a replayed callback (same cookie, same code) is refused without a GitHub call and changes nothing', async () => {
    const h = harness();
    const { started, query } = await connectAs(h);
    const before = await storedRow();
    const calls = h.fake.calls.length;

    const replay = await callback(h, query, started.cookie);

    expectBackToSettings(replay, '/settings?github=failed');
    expect(h.fake.calls.length).toBe(calls);
    expect(await storedRow()).toEqual(before);
    expect(parsedLogs(h.logs)).toContainEqual(
      expect.objectContaining({ reason: 'replayed', securitySignal: 'owner-connect-replayed' }),
    );
  });

  it('a code GitHub refuses (200 with error) → failed, nothing stored (threat row 6)', async () => {
    const h = harness();
    const started = await startConnect(h);
    const state = started.authorizeUrl.searchParams.get('state') ?? '';

    const response = await callback(h, `code=not-issued&state=${state}`, started.cookie);

    expectBackToSettings(response, '/settings?github=failed');
    expect(await storedRow()).toBeNull();
    expect(parsedLogs(h.logs)).toContainEqual(
      expect.objectContaining({ reason: 'code-refused', error: 'bad_verification_code' }),
    );
  });

  // #86: the login is unknown here, so only the fresh token goes — the grant may be the stored connection's.
  it('a non-expiring token (app setting off) → failed, the fresh token revoked, nothing stored (threat row 6)', async () => {
    const h = harness();
    h.fake.fail('exchange-non-expiring');

    const { response } = await connectAs(h);

    expectBackToSettings(response, '/settings?github=failed');
    expect(await storedRow()).toBeNull();
    expect(revokeCalls(h)).toEqual([`DELETE /applications/${env.GITHUB_APP_CLIENT_ID}/token`]);
  });

  it('GET /user failing after the exchange → failed, the fresh token revoked, nothing stored', async () => {
    const h = harness();
    h.fake.fail('user-unavailable');

    const { response } = await connectAs(h);

    expectBackToSettings(response, '/settings?github=failed');
    expect(await storedRow()).toBeNull();
    expect(revokeCalls(h)).toEqual([`DELETE /applications/${env.GITHUB_APP_CLIENT_ID}/token`]);
    expect(parsedLogs(h.logs)).toContainEqual(
      expect.objectContaining({ reason: 'user-lookup-failed', revoked: true }),
    );
  });

  // #86 item 2: GitHub keeps one grant per user, so a grant revoke here would end the stored connection too.
  describe('a reconnect that fails after the exchange keeps the stored connection working', () => {
    it('GET /user fails: only the fresh token is revoked; the stored row and its token still work', async () => {
      const h = harness();
      // Connected a minute ago, so the new attempt's cookie is not taken for a replay.
      const seeded = await seedConnection(h.fake, { nowMs: Date.now() - 60_000 });
      const before = await storedRow();
      h.fake.fail('user-unavailable');

      const { response } = await connectAs(h);

      expectBackToSettings(response, '/settings?github=failed');
      expect(revokeCalls(h)).toEqual([`DELETE /applications/${env.GITHUB_APP_CLIENT_ID}/token`]);
      expect(await storedRow()).toEqual(before);
      expect(h.fake.isAccessTokenLive(seeded.accessToken)).toBe(true);
      expect(h.fake.activeGrants()).toBe(1);
    });

    it('D1 fails while storing the owner pair: only the fresh token is revoked, the grant stays', async () => {
      const h = harness();
      const seeded = await seedConnection(h.fake, { nowMs: Date.now() - 60_000 });
      const bindings = { ...localEnv(), DB: failingOwnerInserts(env.DB) };
      const started = await startConnect(h);
      const code = h.fake.authorize(started.authorizeUrl.href);
      const state = started.authorizeUrl.searchParams.get('state') ?? '';

      const response = await call(h, `/api/v1/github/callback?code=${code}&state=${state}`, {
        bindings,
        headers: { Cookie: started.cookie },
      });

      expectBackToSettings(response, '/settings?github=failed');
      const revokes = revokeCalls(h);
      // The previous token's revoke (item 1) and the fresh token's: never the grant.
      expect(revokes.every((line) => line.endsWith('/token'))).toBe(true);
      expect(revokes).toHaveLength(2);
      expect(h.fake.activeGrants()).toBe(1);
      expect(await storedRow()).not.toBeNull();
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({ message: 'owner connect failed after the exchange', revoked: true }),
      );
      // Item 1 revoked the stored access token before the failed write; the stored refresh token renews it, so
      // the owner is not disconnected (the next owner write's 401 takes this path).
      expect(h.fake.isAccessTokenLive(seeded.accessToken)).toBe(false);
      const connection = await ownerConnection(h.fake);
      connection.invalidate(seeded.accessToken);
      expect(h.fake.isAccessTokenLive(await connection.getToken())).toBe(true);
    });

    it('a GitHub 5xx on the fresh token revoke is logged and still ends in failed', async () => {
      const h = harness();
      await seedConnection(h.fake, { nowMs: Date.now() - 60_000 });
      h.fake.fail('user-unavailable');
      h.fake.fail('token-revoke-unavailable');

      const { response } = await connectAs(h);

      expectBackToSettings(response, '/settings?github=failed');
      expect(h.fake.activeGrants()).toBe(1);
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({
          message: 'owner connect: could not revoke what is not kept',
          scope: 'token',
          problem: 'github-unavailable',
        }),
      );
    });
  });

  describe('a reconnect while connected (#86 item 1)', () => {
    it('revokes the previous access token, then stores the new pair', async () => {
      const h = harness();
      const seeded = await seedConnection(h.fake, { nowMs: Date.now() - 60_000 });

      const { response } = await connectAs(h);

      expectBackToSettings(response, '/settings?github=connected');
      expect(revokeCalls(h)).toEqual([`DELETE /applications/${env.GITHUB_APP_CLIENT_ID}/token`]);
      expect(h.fake.isAccessTokenLive(seeded.accessToken)).toBe(false);
      expect(h.fake.activeGrants()).toBe(1);
      const connectedAt = Date.parse((await storedRow())?.connected_at ?? '');
      expect(connectedAt).toBeGreaterThan(Date.now() - 30_000);
      const status = await call(h, '/api/v1/github/connection');
      expect(await status.json()).toMatchObject({ state: 'connected' });
    });

    it('a GitHub 5xx on that revoke is logged and the reconnect still succeeds', async () => {
      const h = harness();
      const seeded = await seedConnection(h.fake, { nowMs: Date.now() - 60_000 });
      h.fake.fail('token-revoke-unavailable');

      const { response } = await connectAs(h);

      expectBackToSettings(response, '/settings?github=connected');
      expect(h.fake.isAccessTokenLive(seeded.accessToken)).toBe(true);
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({
          message: 'owner reconnect: the previous access token was not revoked',
          reason: 'revoke-failed',
          problem: 'github-unavailable',
        }),
      );
    });
  });

  it('redirects only to the fixed Settings URL, whatever else the query carries', async () => {
    const h = harness();
    const started = await startConnect(h);
    const code = h.fake.authorize(started.authorizeUrl.href);
    const state = started.authorizeUrl.searchParams.get('state') ?? '';

    const response = await callback(
      h,
      `code=${code}&state=${state}&next=https://evil.io&return_to=https://evil.io&redirect_uri=https://evil.io`,
      started.cookie,
    );

    expectBackToSettings(response, '/settings?github=connected');
  });

  // Decision 3's named logging rule; threat row 10.
  it('never logs the callback query (code, state) or the cookie, on success and on refusal', async () => {
    const h = harness();
    const started = await startConnect(h);
    const code = h.fake.authorize(started.authorizeUrl.href);
    const state = started.authorizeUrl.searchParams.get('state') ?? '';
    const cookieValue = started.cookie.split('=')[1] ?? '';

    await callback(h, 'code=SENTINELCODE&state=SENTINELSTATE', `${started.cookie}; other=SENTINELCOOKIE`);
    await callback(h, `code=${code}&state=${state}`, started.cookie);

    const log = h.logs.join('\n');
    for (const secret of ['SENTINELCODE', 'SENTINELSTATE', 'SENTINELCOOKIE', code, state, cookieValue]) {
      expect(log).not.toContain(secret);
    }
    expect(await storedRow()).not.toBeNull();
  });
});

describe('GET /api/v1/github/connection', () => {
  it('not connected → exactly { state, ownerLogin, appName }: the #89 wrong-account copy and the #24 app name', async () => {
    const response = await call(harness(), '/api/v1/github/connection');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      state: 'not-connected',
      ownerLogin: 'geeera',
      appName: 'team-console-local',
    });
  });

  it('not connected, no OWNER_GITHUB_LOGIN configured → 503 github-auth', async () => {
    const response = await call(harness(), '/api/v1/github/connection', {
      bindings: localEnv({ OWNER_GITHUB_LOGIN: '' }),
    });
    expect(response.status).toBe(503);
    expect(await problemSlug(response)).toBe('github-auth');
  });

  it('connected → exactly { state, login, connectedAt, appName }, never a token', async () => {
    const h = harness();
    await connectAs(h);

    const response = await call(h, '/api/v1/github/connection');
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['appName', 'connectedAt', 'login', 'state']);
    expect(body).toMatchObject({ state: 'connected', login: 'geeera', appName: 'team-console-local' });
    expect(Number.isNaN(Date.parse(String(body['connectedAt'])))).toBe(false);
    expect(text).not.toMatch(/gh[ur]_/);
  });

  it('a row under another master key → not-connected, the row is gone, a security signal', async () => {
    const h = harness();
    await seedConnection(h.fake);
    await env.DB.prepare("UPDATE owner_connections SET key_id = '00000000'").run();

    const response = await call(h, '/api/v1/github/connection');

    expect(await response.json()).toEqual({
      state: 'not-connected',
      ownerLogin: 'geeera',
      appName: 'team-console-local',
    });
    expect(await storedRow()).toBeNull();
    expect(parsedLogs(h.logs)).toContainEqual(
      expect.objectContaining({ securitySignal: 'owner-not-connected', reason: 'key-id-mismatch' }),
    );
  });
});

describe('DELETE /api/v1/github/connection', () => {
  it('revokes the grant with the stored token and Basic client credentials, then deletes the row (threat row 11)', async () => {
    const h = harness();
    await connectAs(h);
    expect(h.fake.activeGrants()).toBe(1);
    const callsBefore = h.fake.calls.length;

    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });

    expect(response.status).toBe(204);
    expect(h.fake.calls.slice(callsBefore).map((c) => c.method)).toEqual(['DELETE']);
    expect(h.fake.activeGrants()).toBe(0);
    expect(await storedRow()).toBeNull();
  });

  it('a GitHub 5xx → 502, the row is kept so the owner can retry', async () => {
    const h = harness();
    await connectAs(h);
    h.fake.fail('revoke-unavailable');

    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });

    expect(response.status).toBe(502);
    expect(await problemSlug(response)).toBe('github-unavailable');
    expect(await storedRow()).not.toBeNull();
    expect(h.fake.activeGrants()).toBe(1);
  });

  it('an expired access token is refreshed first, then the grant is revoked', async () => {
    const h = harness();
    await seedConnection(h.fake, { accessSecondsLeft: -5 });

    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });

    expect(response.status).toBe(204);
    const order = h.fake.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(order).toEqual([
      'POST /login/oauth/access_token',
      `DELETE /applications/${env.GITHUB_APP_CLIENT_ID}/grant`,
    ]);
    expect(h.fake.activeGrants()).toBe(0);
    expect(await storedRow()).toBeNull();
  });

  // #87: a refused refresh must not stop the revoke while the stored access token still works.
  it('a still-valid access token revokes without a refresh, even when the refresh token would be refused', async () => {
    const h = harness();
    await seedConnection(h.fake, { accessSecondsLeft: 60 });
    h.fake.fail('refresh-bad-refresh-token');

    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });

    expect(response.status).toBe(204);
    expect(h.fake.refreshCalls()).toBe(0);
    expect(h.fake.activeGrants()).toBe(0);
    expect(await storedRow()).toBeNull();
  });

  describe('no confirmed revoke → 200 revoke-on-github, never a plain 204 (#87, threat row 11)', () => {
    async function expectIncomplete(response: Response, reason: string): Promise<void> {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        revoked: false,
        action: 'revoke-on-github',
        reason,
        manageUrl: 'https://github.com/settings/applications',
      });
    }

    it('expired access token and bad_refresh_token: the row goes, the answer says the grant may be live', async () => {
      const h = harness();
      await seedConnection(h.fake, { accessSecondsLeft: -5 });
      h.fake.fail('refresh-bad-refresh-token');

      await expectIncomplete(
        await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN }),
        'no-usable-token',
      );
      expect(await storedRow()).toBeNull();
      expect(h.fake.activeGrants()).toBe(1);
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({ securitySignal: 'owner-not-connected', reason: 'refresh-refused' }),
      );
    });

    it('an undecryptable row: no GitHub call, the row goes, the answer says the grant may be live', async () => {
      const h = harness();
      await seedConnection(h.fake);
      await env.DB.prepare(
        "UPDATE owner_connections SET access_token_enc = 'ff' || substr(access_token_enc, 3)",
      ).run();

      await expectIncomplete(
        await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN }),
        'no-usable-token',
      );
      expect(h.fake.calls).toEqual([]);
      expect(await storedRow()).toBeNull();
    });

    it('GitHub rejects the stored token (someone else refreshed the chain): signal logged, grant may be live', async () => {
      const h = harness();
      const seeded = await seedConnection(h.fake);
      // Another holder of the chain refreshes it: GitHub ends our stored access token with it.
      await h.fake.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: env.GITHUB_APP_CLIENT_ID,
          client_secret: env.GITHUB_APP_CLIENT_SECRET ?? '',
          grant_type: 'refresh_token',
          refresh_token: seeded.refreshToken,
        }).toString(),
      });

      await expectIncomplete(
        await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN }),
        'token-rejected',
      );
      expect(await storedRow()).toBeNull();
      expect(h.fake.activeGrants()).toBe(1);
      expect(parsedLogs(h.logs)).toContainEqual(
        expect.objectContaining({ securitySignal: 'owner-not-connected', reason: 'revoke-token-rejected' }),
      );
    });
  });

  it('a row under another master key: no GitHub call, the row goes, the answer says the grant may be live', async () => {
    const h = harness();
    await seedConnection(h.fake);
    await env.DB.prepare("UPDATE owner_connections SET key_id = '00000000'").run();

    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revoked: false,
      action: 'revoke-on-github',
      reason: 'no-usable-token',
    });
    expect(h.fake.calls).toEqual([]);
    expect(await storedRow()).toBeNull();
    expect(h.fake.activeGrants()).toBe(1);
  });

  it('not connected → 204 without a GitHub call', async () => {
    const h = harness();
    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });
    expect(response.status).toBe(204);
    expect(h.fake.calls).toEqual([]);
  });
});

// #86 item 5 (threat row 10): every answer of the connection routes, errors included, is never cached.
describe('Cache-Control: no-store on every #59 answer', () => {
  async function serviceBindings() {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    return {
      bindings: accessEnv(teamDomain, { ENVIRONMENT: 'dev' }),
      token: await signAccessToken(key, teamDomain, {
        claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
      }),
    };
  }

  it.each([
    ['connect misconfigured → 503', 'POST', '/api/v1/github/connect', { GITHUB_APP_CLIENT_SECRET: '' }, 503],
    [
      'connection without OWNER_GITHUB_LOGIN → 503',
      'GET',
      '/api/v1/github/connection',
      { OWNER_GITHUB_LOGIN: '' },
      503,
    ],
    ['disconnect, not connected → 204', 'DELETE', '/api/v1/github/connection', {}, 204],
    ['callback without a cookie → 302', 'GET', '/api/v1/github/callback?code=abc&state=def', {}, 302],
  ] as const)('%s', async (_label, method, path, overrides, status) => {
    const response = await call(harness(), path, {
      method,
      headers: SAME_ORIGIN,
      bindings: localEnv(overrides),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('disconnect with GitHub down → 502', async () => {
    const h = harness();
    await connectAs(h);
    h.fake.fail('revoke-unavailable');
    const response = await call(h, '/api/v1/github/connection', { method: 'DELETE', headers: SAME_ORIGIN });
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('the service identity refused → 403', async () => {
    const { bindings, token } = await serviceBindings();
    const response = await call(harness(), '/api/v1/github/connection', {
      bindings,
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
