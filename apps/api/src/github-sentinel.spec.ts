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

// #9 threat row 3 / ADR 0003 decision 8: no installation token (`ghs_`), owner token (`ghu_`, `ghr_`), app JWT
// (`eyJ`) or private key may appear in a response body, a response header or a log line — on any route, for any
// GitHub outcome, including thrown errors whose message carries them.

const FORBIDDEN = [TOKEN_SENTINEL, 'ghs_', 'ghu_', 'ghr_', 'eyJ', 'PRIVATE KEY'];
const OWNER_TOKEN = 'ghu_TESTSENTINELowner';
const REFRESH_TOKEN = 'ghr_TESTSENTINELrefresh';
const LEAKY_TEXT = `token ${TOKEN_SENTINEL}9 ${OWNER_TOKEN} ${REFRESH_TOKEN} eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2ln -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`;

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
    read: () => json(200, { full_name: 'geeera/team-console', private: false, default_branch: 'dev' }),
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
    env: { GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----' },
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

function expectClean(label: string, text: string): void {
  for (const forbidden of FORBIDDEN) {
    expect(text.includes(forbidden), `${label} contains ${forbidden}`).toBe(false);
  }
}

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', 'geeera/team-console');
});

it('covers the GitHub route (the inventory is not vacuous)', () => {
  expect(ROUTES).toEqual(expect.arrayContaining([['GET', '/api/v1/projects/tc/repository']]));
});

describe.each(Object.entries(SCENARIOS))('GitHub scenario: %s', (_name, scenario) => {
  it.each(ROUTES)('%s %s leaks no credential in body, headers or logs', async (method, path) => {
    const stub = stubGitHub(scenario.read ?? (() => json(200, {})), scenario.installation, scenario.app);
    const lines: string[] = [];

    const response = await fetchApi(path, localEnv(scenario.env), {
      method,
      github: new ApiGitHub({ fetch: stub.fetch }),
      logSink: (line) => lines.push(line),
      headers: { 'Sec-Fetch-Site': 'same-origin' },
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
