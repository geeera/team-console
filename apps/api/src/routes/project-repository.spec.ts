import { env } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails, type ProblemDetails } from '@shared/contracts';
import { MemoryReadCache, parseRepoName } from '@worker/github';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  INSTALLATION_ID,
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  verifyAppJwt,
  type ReadHandler,
  type StubGitHub,
} from '../testing/github-kit';

// #9 acceptance criteria through the one route that reads GitHub: GET /api/v1/projects/:slug/repository.

const REPO_JSON = {
  full_name: 'geeera/team-console',
  private: false,
  default_branch: 'dev',
  owner: { login: 'geeera' },
};
const path = (slug: string) => `/api/v1/projects/${slug}/repository`;
const readsRepo: ReadHandler = () => json(200, REPO_JSON);

async function problemOf(response: Response): Promise<ProblemDetails> {
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem body: ${JSON.stringify(body)}`);
  }
  return body;
}

function setup(
  read: ReadHandler = readsRepo,
  installation?: () => Response,
): { github: ApiGitHub; stub: StubGitHub } {
  const stub = stubGitHub(read, installation);
  return { stub, github: new ApiGitHub({ fetch: stub.fetch }) };
}

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', 'geeera/team-console');
});

describe('the app flow (ADR 0003 decision 6)', () => {
  it('looks up the installation with the app JWT, mints a downscoped token and reads with it', async () => {
    const { github, stub } = setup();

    const response = await fetchApi(path('tc'), localEnv(), { github });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repo: 'geeera/team-console',
      private: false,
      defaultBranch: 'dev',
    });
    const [lookup, mint, read] = stub.calls;
    expect(stub.calls).toHaveLength(3);

    expect(`${lookup?.method} ${lookup?.url.href}`).toBe(
      'GET https://api.github.com/repos/geeera/team-console/installation',
    );
    const claims = await verifyAppJwt(lookup?.headers.get('authorization') ?? null);
    expect(claims['iss']).toBe(env.GITHUB_APP_ID);
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(600);

    expect(`${mint?.method} ${mint?.url.href}`).toBe(
      `POST https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
    await verifyAppJwt(mint?.headers.get('authorization') ?? null);
    expect(JSON.parse(mint?.body ?? '')).toEqual({
      repositories: ['team-console'],
      permissions: {
        metadata: 'read',
        issues: 'read',
        pull_requests: 'read',
        contents: 'read',
        actions: 'read',
      },
    });

    expect(`${read?.method} ${read?.url.href}`).toBe('GET https://api.github.com/repos/geeera/team-console');
    expect(read?.headers.get('authorization')).toBe(`Bearer ${TOKEN_SENTINEL}1`);
  });

  it('reuses the installation token for the next read (one subrequest after the read cache expires)', async () => {
    let now = Date.now();
    const stub = stubGitHub(readsRepo);
    const github = new ApiGitHub({ fetch: stub.fetch, readCache: new MemoryReadCache({ now: () => now }) });

    await fetchApi(path('tc'), localEnv(), { github });
    now += 61_000;
    await fetchApi(path('tc'), localEnv(), { github });

    expect(stub.minted()).toBe(1);
    expect(stub.reads()).toHaveLength(2);
    expect(stub.calls).toHaveLength(4);
  });

  it('evicts a cached token GitHub rejects with 401 and retries once with a new one', async () => {
    let now = Date.now();
    let reads = 0;
    const stub = stubGitHub(() => {
      reads += 1;
      return reads === 2 ? json(401, { message: 'Bad credentials' }) : json(200, REPO_JSON);
    });
    const github = new ApiGitHub({ fetch: stub.fetch, readCache: new MemoryReadCache({ now: () => now }) });

    await fetchApi(path('tc'), localEnv(), { github });
    now += 61_000;
    const response = await fetchApi(path('tc'), localEnv(), { github });

    expect(response.status).toBe(200);
    expect(stub.minted()).toBe(2);
    expect(stub.reads().map((call) => call.headers.get('authorization'))).toEqual([
      `Bearer ${TOKEN_SENTINEL}1`,
      `Bearer ${TOKEN_SENTINEL}1`,
      `Bearer ${TOKEN_SENTINEL}2`,
    ]);
  });

  it('answers 409 github-app-not-installed with the repository in detail', async () => {
    const { github, stub } = setup(readsRepo, () => json(404, { message: 'Not Found' }));

    const response = await fetchApi(path('tc'), localEnv(), { github });

    expect(response.status).toBe(409);
    expect(await problemOf(response)).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}github-app-not-installed`,
      detail: 'Install the team-console app on geeera/team-console',
    });
    expect(stub.minted()).toBe(0);
  });
});

describe('a wrong GITHUB_APP_ID', () => {
  // api.github.com answers such a JWT with 404 "Integration not found" on the lookup (verified 2026-09-30).
  it('answers 503 github-auth, not "install the app"', async () => {
    const stub = stubGitHub(
      readsRepo,
      () => json(404, { message: 'Integration not found' }),
      () => json(404, { message: 'Integration not found' }),
    );
    const response = await fetchApi(path('tc'), localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) });
    expect(response.status).toBe(503);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}github-auth`);
  });
});

describe('error mapping through the route (a test per row)', () => {
  it.each([
    ['401 twice', () => json(401, {}), 503, 'github-auth'],
    ['403 without rate-limit headers', () => json(403, {}), 503, 'github-auth'],
    ['404', () => json(404, {}), 404, 'github-not-found'],
    ['5xx', () => json(503, {}), 502, 'github-unavailable'],
    ['a network failure', () => Promise.reject(new TypeError('network down')), 502, 'github-unavailable'],
    ['an unexpected status', () => json(418, {}), 502, 'github-unexpected'],
    ['a body of the wrong shape', () => json(200, { full_name: 1 }), 502, 'github-unexpected'],
  ] as const)('%s → %i %s', async (_label, read, status, type) => {
    const { github } = setup(read);
    const response = await fetchApi(path('tc'), localEnv(), { github });
    expect(response.status).toBe(status);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}${type}`);
  });

  it('rate limit → 429 with Retry-After', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { github } = setup(() =>
      json(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
    );
    const response = await fetchApi(path('tc'), localEnv(), { github });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(119);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}github-rate-limit`);
  });

  it('a redirect off api.github.com → 502 github-unexpected and no request reaches the other host (row 1)', async () => {
    const { github, stub } = setup(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }),
    );
    const response = await fetchApi(path('tc'), localEnv(), { github });
    expect(response.status).toBe(502);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}github-unexpected`);
    expect(stub.calls.every((call) => call.url.origin === 'https://api.github.com')).toBe(true);
  });

  it.each([
    [
      'a PKCS#1 key',
      // Assembled at run time so the repository's secret scanners never see a key-shaped literal.
      {
        GITHUB_APP_PRIVATE_KEY: ['BEGIN', 'END']
          .map((edge) => `-----${edge} RSA ${'PRIVATE'} KEY-----`)
          .join('\nMIIEow\n'),
      },
    ],
    ['no key', { GITHUB_APP_PRIVATE_KEY: undefined }],
    ['no app id', { GITHUB_APP_ID: '' }],
  ] as const)('%s → 503 github-auth before any request to GitHub', async (_label, overrides) => {
    const { github, stub } = setup();
    const response = await fetchApi(path('tc'), localEnv(overrides), { github });
    expect(response.status).toBe(503);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}github-auth`);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('the read cache (60 s, env:slug:epoch:type)', () => {
  it('serves a second read within the TTL without GitHub', async () => {
    const { github, stub } = setup();
    await fetchApi(path('tc'), localEnv(), { github });
    const second = await fetchApi(path('tc'), localEnv(), { github });
    expect(second.status).toBe(200);
    expect(stub.reads()).toHaveLength(1);
  });

  it('fills per slug and again after an epoch bump', async () => {
    await seedProject('other', 'geeera/other');
    const { github, stub } = setup((call) =>
      json(200, { ...REPO_JSON, full_name: call.url.pathname.slice('/repos/'.length) }),
    );

    await expect((await fetchApi(path('tc'), localEnv(), { github })).json()).resolves.toMatchObject({
      repo: 'geeera/team-console',
    });
    await expect((await fetchApi(path('other'), localEnv(), { github })).json()).resolves.toMatchObject({
      repo: 'geeera/other',
    });
    expect(stub.reads()).toHaveLength(2);

    await env.DB.prepare('UPDATE projects SET cache_epoch = cache_epoch + 1 WHERE slug = ?1')
      .bind('tc')
      .run();
    await fetchApi(path('tc'), localEnv(), { github });
    expect(stub.reads()).toHaveLength(3);
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const { github } = setup(() => (fail ? json(503, {}) : json(200, REPO_JSON)));
    expect((await fetchApi(path('tc'), localEnv(), { github })).status).toBe(502);
    fail = false;
    expect((await fetchApi(path('tc'), localEnv(), { github })).status).toBe(200);
  });
});

describe('the repository comes only from a valid registry row (row 2)', () => {
  it.each(['nope', 'TC', 'tc%2F..%2Fx', '..', '%2e%2e', 'a'.repeat(41), 'tc%3Fx%3D1'])(
    'slug %s → 404 project-not-found before any fetch',
    async (slug) => {
      const { github, stub } = setup();
      const response = await fetchApi(path(slug), localEnv(), { github });
      expect(response.status).toBe(404);
      expect(stub.calls).toHaveLength(0);
    },
  );

  it('an archived project → 404 project-not-found', async () => {
    await env.DB.prepare('UPDATE projects SET archived_at = ?1 WHERE slug = ?2')
      .bind('2026-09-30T00:00:00Z', 'tc')
      .run();
    const { github, stub } = setup();
    const response = await fetchApi(path('tc'), localEnv(), { github });
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}project-not-found`);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([
    '../../app/installations/1/access_tokens',
    'geeera/..',
    'geeera/team-console/../../app',
    'geeera%2F..%2Fapp/x',
    'geeera/team console',
  ])('a registry row with repo %s → 500 project-invalid; the JWT is never pointed at it', async (repo) => {
    await seedProject('bad', repo);
    const { github, stub } = setup();
    const response = await fetchApi(path('bad'), localEnv(), { github });
    expect(response.status).toBe(500);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}project-invalid`);
    expect(stub.calls).toHaveLength(0);
  });

  it('encodes each segment of a valid name', async () => {
    await seedProject('dots', 'geeera/.github');
    const { github, stub } = setup(() => json(200, { ...REPO_JSON, full_name: 'geeera/.github' }));
    expect((await fetchApi(path('dots'), localEnv(), { github })).status).toBe(200);
    expect(stub.calls[0]?.url.pathname).toBe('/repos/geeera/.github/installation');
  });
});

describe('mock mode (row 7)', () => {
  it('serves fixtures through the real flow when ENVIRONMENT=local and GITHUB_MOCK=true', async () => {
    const { github, stub } = setup();
    const response = await fetchApi(path('tc'), localEnv({ GITHUB_MOCK: 'true' }), { github });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repo: 'geeera/team-console',
      private: false,
      defaultBranch: 'dev',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('answers the not-installed state from fixtures too', async () => {
    await seedProject('stranger', 'someone/else');
    const response = await fetchApi(path('stranger'), localEnv({ GITHUB_MOCK: 'true' }), {
      github: new ApiGitHub(),
    });
    expect(response.status).toBe(409);
  });

  it.each(['dev', 'stage', 'production'])(
    'is ignored with ENVIRONMENT=%s: the real app is used',
    async (environment) => {
      const { github, stub } = setup();
      const { auth } = await github.connect(localEnv({ ENVIRONMENT: environment, GITHUB_MOCK: 'true' }));
      await expect(auth.installationIdFor(parseRepoName('geeera/team-console'))).resolves.toBe(
        INSTALLATION_ID,
      );
      expect(stub.calls).toHaveLength(1);
    },
  );
});
