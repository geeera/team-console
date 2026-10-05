import { env } from 'cloudflare:test';
import { createApiApp } from './app';
import { ApiGitHub } from './github';
import { fetchApi } from './testing/access-kit';
import {
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type ReadHandler,
} from './testing/github-kit';
import type { FakeGitHubOAuth } from '@worker/github/testing';
import { OWNER, fakeGitHub, resetOwnerConnections } from './testing/owner-kit';

// #9 threat row 3 / ADR 0003 decision 8: no installation token (`ghs_`), owner token (`ghu_`, `ghr_`), app JWT
// (`eyJ`) or private key may appear in a response body, a response header or a log line — on any route, for any
// GitHub outcome, including thrown errors whose message carries them.

// #59 adds the app's client secret and the master key (both generated per run in vitest.config.mts).
const FORBIDDEN = [
  TOKEN_SENTINEL,
  'ghs_',
  'ghu_',
  'ghr_',
  'eyJ',
  'PRIVATE KEY',
  env.GITHUB_APP_CLIENT_SECRET ?? 'unset',
  env.TOKEN_ENCRYPTION_KEY ?? 'unset',
];
// Assembled at run time so the repository's secret scanners (gitleaks, Semgrep) never see a credential-shaped
// literal; at run time they are the real shapes: `ghu_…`, `ghr_…`, a three-part `eyJ…` JWT, a PEM block.
const OWNER_TOKEN = ['ghu', 'TESTSENTINELowner'].join('_');
const REFRESH_TOKEN = ['ghr', 'TESTSENTINELrefresh'].join('_');
const JWT_LIKE = [btoa('{"alg":"RS256"}'), btoa('{"iss":"1"}'), 'c2ln'].join('.');
const KEY_LABEL = `${'PRIVATE'} KEY`;
const PEM_LIKE = `-----BEGIN ${KEY_LABEL}-----\nMIIE\n-----END ${KEY_LABEL}-----`;
const LEAKY_TEXT = `token ${TOKEN_SENTINEL}9 ${OWNER_TOKEN} ${REFRESH_TOKEN} ${JWT_LIKE} ${PEM_LIKE}`;

const SCENARIOS: Record<
  string,
  {
    read?: ReadHandler;
    installation?: () => Response;
    app?: () => Response;
    env?: Record<string, string>;
  }
> = {
  success: {
    read: () =>
      json(200, {
        full_name: 'geeera/team-console',
        private: false,
        default_branch: 'dev',
        owner: { login: 'geeera', id: 1 },
      }),
  },
  'not installed': { installation: () => json(404, { message: LEAKY_TEXT }) },
  'unknown app id': {
    installation: () => json(404, { message: LEAKY_TEXT }),
    app: () => json(404, { message: LEAKY_TEXT }),
  },
  '401 (twice)': { read: () => json(401, { message: LEAKY_TEXT }) },
  '403': { read: () => json(403, { message: LEAKY_TEXT }) },
  'rate limit': { read: () => json(429, { message: LEAKY_TEXT }, { 'retry-after': '3' }) },
  '404': { read: () => json(404, { message: LEAKY_TEXT }) },
  '5xx': { read: () => json(502, { message: LEAKY_TEXT }) },
  'unexpected status': { read: () => json(422, { message: LEAKY_TEXT }) },
  'body of the wrong shape': { read: () => json(200, { message: LEAKY_TEXT }) },
  'redirect off host': {
    read: () =>
      new Response(null, { status: 307, headers: { location: `https://evil.example/?t=${OWNER_TOKEN}` } }),
  },
  'thrown network error': {
    read: () => {
      throw new TypeError(LEAKY_TEXT, { cause: { authorization: `Bearer ${TOKEN_SENTINEL}1` } });
    },
  },
  'thrown during the lookup': {
    installation: () => {
      throw new Error(LEAKY_TEXT);
    },
  },
  'PKCS#1 key': {
    env: { GITHUB_APP_PRIVATE_KEY: PEM_LIKE.replaceAll(KEY_LABEL, `RSA ${KEY_LABEL}`) },
  },
};

function concretePath(pattern: string): string {
  return pattern
    .replace(/:slug/g, 'tc')
    .replace(/:[^/]+/g, 'x')
    .replace(/\*/g, 'x');
}

const ROUTES = createApiApp()
  .routes.filter((route) => route.path.startsWith('/api/') && route.method !== 'ALL')
  .map((route) => [route.method, concretePath(route.path)] as const);

// The PKCE challenge in connect's authorize URL is public by design (a SHA-256 of the verifier) and 43 random
// base64url characters, which contain "eyJ" about once in 6,000 runs; only that value is masked before the check.
const PKCE_CHALLENGE = /(code_challenge=)[A-Za-z0-9_-]{43}/g;

function expectClean(label: string, text: string): void {
  const checked = text.replace(PKCE_CHALLENGE, '$1<challenge>');
  for (const forbidden of FORBIDDEN) {
    expect(checked.includes(forbidden), `${label} contains ${forbidden}`).toBe(false);
  }
}

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', 'geeera/team-console');
});

it('covers the GitHub routes (the inventory is not vacuous)', () => {
  expect(ROUTES).toEqual(
    expect.arrayContaining([
      ['GET', '/api/v1/projects/tc/repository'],
      ['POST', '/api/v1/github/connect'],
      ['GET', '/api/v1/github/callback'],
      ['GET', '/api/v1/github/connection'],
      ['DELETE', '/api/v1/github/connection'],
      ['GET', '/api/v1/projects/tc/setup'],
      ['POST', '/api/v1/projects'],
      ['GET', '/api/v1/projects/tc/inbox'],
      ['GET', '/api/v1/projects/tc/questions'],
      ['GET', '/api/v1/projects/tc/sprint'],
      ['GET', '/api/v1/needs-you'],
    ]),
  );
});

describe.each(Object.entries(SCENARIOS))('GitHub scenario: %s', (_name, scenario) => {
  it.each(ROUTES)('%s %s leaks no credential in body, headers or logs', async (method, path) => {
    const stub = stubGitHub(scenario.read ?? (() => json(200, {})), scenario.installation, scenario.app);
    const lines: string[] = [];

    // A connected owner and a JSON body let the registry's writes reach GitHub instead of stopping at validation.
    const response = await fetchApi(path, localEnv({ OWNER_GITHUB_LOGIN: 'geeera', ...scenario.env }), {
      method,
      ...(method === 'GET'
        ? {}
        : { body: JSON.stringify({ repo: 'geeera/new-product', displayName: 'New' }) }),
      github: new ApiGitHub({ fetch: stub.fetch }),
      logSink: (line) => lines.push(line),
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    });

    expectClean('body', await response.text());
    expectClean('headers', JSON.stringify([...response.headers.entries()]));
    expectClean('logs', lines.join('\n'));
  });
});

it('logs the GitHub status of a failure, and only that about GitHub', async () => {
  const stub = stubGitHub(() => json(403, { message: LEAKY_TEXT }));
  const lines: string[] = [];
  await fetchApi('/api/v1/projects/tc/repository', localEnv(), {
    github: new ApiGitHub({ fetch: stub.fetch }),
    logSink: (line) => lines.push(line),
  });
  const failure = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line['message'] === 'request failed');
  expect(failure).toMatchObject({ level: 'warn', problem: 'github-auth', status: 503, githubStatus: 403 });
});

describe('owner connection (#59): every outcome of connect, callback, connection, refresh and disconnect', () => {
  interface Seen {
    readonly github: ApiGitHub;
    readonly fake: FakeGitHubOAuth;
    readonly lines: string[];
    readonly texts: string[];
  }

  function seen(): Seen {
    const fake = fakeGitHub();
    return { github: new ApiGitHub({ fetch: fake.fetch }), fake, lines: [], texts: [] };
  }

  async function send(
    s: Seen,
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const response = await fetchApi(path, localEnv(), {
      method,
      github: s.github,
      logSink: (line) => s.lines.push(line),
      headers: { 'Sec-Fetch-Site': 'same-origin', ...headers },
    });
    s.texts.push(await response.clone().text(), JSON.stringify([...response.headers.entries()]));
    return response;
  }

  async function connect(s: Seen, user = OWNER): Promise<void> {
    const started = await send(s, 'POST', '/api/v1/github/connect');
    const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
    const cookie = started.headers.get('set-cookie')?.split(';')[0] ?? '';
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const code = s.fake.authorize(authorizeUrl, user);
    await send(s, 'GET', `/api/v1/github/callback?code=${code}&state=${state}`, { Cookie: cookie });
    // Replay, tampered state, no cookie.
    await send(s, 'GET', `/api/v1/github/callback?code=${code}&state=${state}`, { Cookie: cookie });
    await send(s, 'GET', `/api/v1/github/callback?code=${code}&state=${'0'.repeat(64)}`, { Cookie: cookie });
    await send(s, 'GET', `/api/v1/github/callback?code=${code}&state=${state}`);
  }

  function expectAllClean(s: Seen): void {
    expectClean('bodies and headers', s.texts.join('\n'));
    expectClean('logs', s.lines.join('\n'));
  }

  beforeEach(async () => {
    await resetOwnerConnections();
  });

  it('owner connects, reads the connection, refreshes, disconnects', async () => {
    const s = seen();
    await connect(s);
    await send(s, 'GET', '/api/v1/github/connection');
    await env.DB.prepare('UPDATE owner_connections SET access_expires_at = 0').run();
    await send(s, 'DELETE', '/api/v1/github/connection');
    expect(s.fake.refreshCalls()).toBe(2);
    expectAllClean(s);
  });

  it('a stranger authorizes (grant revoked), GitHub fails at every step', async () => {
    const s = seen();
    await connect(s, { login: 'stranger', id: 7 });
    s.fake.fail('exchange-non-expiring');
    await connect(s);
    s.fake.fail('user-unavailable');
    await connect(s);
    await connect(s);
    s.fake.fail('revoke-unavailable');
    await send(s, 'DELETE', '/api/v1/github/connection');
    await env.DB.prepare('UPDATE owner_connections SET access_expires_at = 0').run();
    s.fake.fail('refresh-unavailable');
    await send(s, 'DELETE', '/api/v1/github/connection');
    s.fake.fail('refresh-bad-refresh-token');
    await send(s, 'DELETE', '/api/v1/github/connection');
    await send(s, 'GET', '/api/v1/github/connection');
    expectAllClean(s);
  });
});
