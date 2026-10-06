import { env } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails, type InstallationRepositoriesDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import {
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  type GitHubCall,
} from '../testing/github-kit';
import { readInstallationList } from './installation-repositories';

// #194 acceptance criteria and architect note §8: the installation list against a scripted GitHub and the pool's D1.

const PATH = '/api/v1/github/installation/repositories';
const OWNER_ID = 100001;
const INSTALLATION = 5150;
const CONNECTED: OwnerConnectionSource = { current: async () => ({ login: 'geeera', userId: OWNER_ID }) };
const NOT_CONNECTED: OwnerConnectionSource = { current: async () => null };

interface ListScript {
  /** Repositories on the installation, in GitHub's order. */
  readonly repos?: readonly { name: string; private?: boolean }[];
  readonly perPage?: number;
  /** Replaces `GET /app/installations`. */
  readonly installations?: () => Response;
  /** Replaces `GET /app`. */
  readonly app?: () => Response;
  /** Replaces one page of the list (`page` from 1). */
  readonly page?: (page: number) => Response | undefined;
}

interface ListStub {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly calls: GitHubCall[];
  readonly listReads: () => number;
  readonly mints: () => GitHubCall[];
}

function listStub(script: ListScript = {}): ListStub {
  const calls: GitHubCall[] = [];
  const repos = script.repos ?? [{ name: 'geeera/one' }];
  const perPage = script.perPage ?? 100;
  let minted = 0;
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const call: GitHubCall = {
      url: new URL(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const path = call.url.pathname;
    if (call.method === 'GET' && path === '/app/installations') {
      return (
        script.installations?.() ??
        json(200, [
          { id: 1, account: { id: 7, login: 'someone' } },
          { id: INSTALLATION, account: { id: OWNER_ID, login: 'geeera' } },
        ])
      );
    }
    if (call.method === 'GET' && path === '/app') {
      return script.app?.() ?? json(200, { id: Number(env.GITHUB_APP_ID) });
    }
    if (call.method === 'POST' && path === `/app/installations/${INSTALLATION}/access_tokens`) {
      minted += 1;
      return json(201, {
        token: `${TOKEN_SENTINEL}list${minted}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    if (call.method === 'GET' && path === '/installation/repositories') {
      const page = Number(call.url.searchParams.get('page') ?? '1');
      const replaced = script.page?.(page);
      if (replaced !== undefined) {
        return replaced;
      }
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      const more = page * perPage < repos.length;
      return json(
        200,
        {
          total_count: repos.length,
          repositories: slice.map((repo, index) => ({
            id: page * 1000 + index,
            full_name: repo.name,
            private: repo.private ?? false,
          })),
        },
        more
          ? {
              link: `<https://api.github.com/installation/repositories?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {},
      );
    }
    return json(404, { message: 'Not Found' });
  };
  return {
    fetch,
    calls,
    listReads: () => calls.filter((call) => call.url.pathname === '/installation/repositories').length,
    mints: () => calls.filter((call) => call.method === 'POST'),
  };
}

const manyRepos = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `geeera/r${String(index).padStart(4, '0')}` }));

async function list(
  stub: ListStub,
  options: { github?: ApiGitHub; owners?: OwnerConnectionSource; query?: string; lines?: string[] } = {},
): Promise<Response> {
  return fetchApi(`${PATH}${options.query ?? ''}`, localEnv(), {
    github: options.github ?? new ApiGitHub({ fetch: stub.fetch }),
    ownerConnection: options.owners ?? CONNECTED,
    ...(options.lines === undefined ? {} : { logSink: (line: string) => options.lines?.push(line) }),
  });
}

async function bodyOf(response: Response): Promise<InstallationRepositoriesDto> {
  expect(response.status).toBe(200);
  return (await response.json()) as InstallationRepositoriesDto;
}

async function expectProblem(
  response: Response,
  status: number,
  type: string,
  members: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem body: ${JSON.stringify(body)}`);
  }
  expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}${type}`, status, ...members });
  return body as unknown as Record<string, unknown>;
}

beforeEach(async () => {
  await resetProjects();
});

describe('GET /api/v1/github/installation/repositories', () => {
  it('lists one page, sorted, with each repository matched to the registry without a /repos/ call', async () => {
    await seedProject('team-console', 'GEEERA/Team-Console');
    await seedProject('old', 'geeera/old-landing');
    await env.DB.prepare("UPDATE projects SET archived_at = '2026-10-01T00:00:00Z' WHERE slug = 'old'").run();
    const stub = listStub({
      repos: [
        { name: 'geeera/storify', private: true },
        { name: 'geeera/team-console' },
        { name: 'geeera/old-landing' },
        { name: 'geeera/Alpha' },
      ],
    });

    const response = await list(stub);
    const body = await bodyOf(response);

    expect(body).toEqual({
      repositories: [
        { fullName: 'geeera/Alpha', private: false, registration: { state: 'none' } },
        { fullName: 'geeera/old-landing', private: false, registration: { state: 'archived', slug: 'old' } },
        { fullName: 'geeera/storify', private: true, registration: { state: 'none' } },
        {
          fullName: 'geeera/team-console',
          private: false,
          registration: { state: 'active', slug: 'team-console' },
        },
      ],
      partial: false,
      selectionUrl: `https://github.com/settings/installations/${INSTALLATION}`,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(stub.calls.some((call) => call.url.pathname.startsWith('/repos/'))).toBe(false);
    expect(stub.calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      'GET /app/installations?per_page=100',
      `POST /app/installations/${INSTALLATION}/access_tokens`,
      'GET /installation/repositories?per_page=100',
    ]);
  });

  it('mints the list token with exactly {"permissions":{"metadata":"read"}} and reads the list with it', async () => {
    const stub = listStub();
    await bodyOf(await list(stub));
    const [mint] = stub.mints();
    expect(mint?.body).toBe('{"permissions":{"metadata":"read"}}');
    const read = stub.calls.find((call) => call.url.pathname === '/installation/repositories');
    expect(read?.headers.get('authorization')).toBe(`Bearer ${TOKEN_SENTINEL}list1`);
  });

  it('follows Link through 3 pages: 3 reads, not partial', async () => {
    const stub = listStub({ repos: manyRepos(250) });
    const body = await bodyOf(await list(stub));
    expect(stub.listReads()).toBe(3);
    expect(body.repositories).toHaveLength(250);
    expect(body.partial).toBe(false);
  });

  it('stops at the page cap: 11 pages available → exactly 10 reads, partial', async () => {
    const stub = listStub({ repos: manyRepos(1050) });
    const body = await bodyOf(await list(stub));
    expect(stub.listReads()).toBe(10);
    expect(body.repositories).toHaveLength(1000);
    expect(body.partial).toBe(true);
  });

  it('answers an empty installation as an empty, complete list', async () => {
    const body = await bodyOf(await list(listStub({ repos: [] })));
    expect(body).toMatchObject({ repositories: [], partial: false });
  });

  it('answers 403 github-owner-not-connected with connectUrl and asks GitHub nothing when not connected', async () => {
    const stub = listStub();
    await expectProblem(await list(stub, { owners: NOT_CONNECTED }), 403, 'github-owner-not-connected', {
      connectUrl: '/api/v1/github/connect',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('treats the #59 connection in D1 as the owner: none stored → 403 before any JWT', async () => {
    const stub = listStub();
    const response = await fetchApi(PATH, localEnv({ OWNER_GITHUB_LOGIN: 'geeera' }), {
      github: new ApiGitHub({ fetch: stub.fetch }),
    });
    await expectProblem(response, 403, 'github-owner-not-connected');
    expect(stub.calls).toHaveLength(0);
  });

  it('answers 409 github-app-not-installed with the install URL when no installation is on the account', async () => {
    const stub = listStub({ installations: () => json(200, [{ id: 1, account: { id: 7 } }]) });
    const body = await expectProblem(await list(stub), 409, 'github-app-not-installed');
    expect(body['installUrl']).toBe('https://github.com/apps/team-console-local/installations/new');
    expect(new URL(String(body['installUrl'])).origin).toBe('https://github.com');
    expect(stub.mints()).toHaveLength(0);
  });

  it.each([
    ['the JWT is refused', { installations: () => json(401, {}) }, 503, 'github-auth'],
    [
      'the app id is unknown (404, then GET /app 404)',
      { installations: () => json(404, {}), app: () => json(404, {}) },
      503,
      'github-auth',
    ],
    ['GitHub is down', { page: () => json(502, {}) }, 502, 'github-unavailable'],
    [
      'the list has the wrong shape',
      { page: () => json(200, [{ full_name: 'x/y' }]) },
      502,
      'github-unexpected',
    ],
    [
      'GitHub names more installations without a match',
      {
        installations: () =>
          json(200, [{ id: 1, account: { id: 7 } }], {
            link: '<https://api.github.com/app/installations?page=2>; rel="next"',
          }),
      },
      502,
      'github-unexpected',
    ],
  ] as const)('maps %s to %i %s', async (_label, script, status, type) => {
    await expectProblem(await list(listStub(script)), status, type);
  });

  it('answers 429 github-rate-limit with Retry-After', async () => {
    const stub = listStub({
      page: () => json(403, {}, { 'x-ratelimit-remaining': '0', 'retry-after': '42' }),
    });
    const response = await list(stub);
    await expectProblem(response, 429, 'github-rate-limit');
    expect(response.headers.get('retry-after')).toBe('42');
  });

  it('serves a second request within 60 s from the cache and re-reads with ?fresh=1', async () => {
    const stub = listStub();
    const github = new ApiGitHub({ fetch: stub.fetch });
    await bodyOf(await list(stub, { github }));
    await bodyOf(await list(stub, { github }));
    expect(stub.listReads()).toBe(1);
    await bodyOf(await list(stub, { github, query: '?fresh=1' }));
    expect(stub.listReads()).toBe(2);
    // The warm list token is reused: one mint for all three.
    expect(stub.mints()).toHaveLength(1);
  });

  it('shows a project added a moment ago as active from the cached list, without asking GitHub again', async () => {
    const stub = listStub({ repos: [{ name: 'geeera/storify' }] });
    const github = new ApiGitHub({ fetch: stub.fetch });
    expect((await bodyOf(await list(stub, { github }))).repositories[0]?.registration).toEqual({
      state: 'none',
    });
    await seedProject('storify', 'geeera/storify');
    expect((await bodyOf(await list(stub, { github }))).repositories[0]?.registration).toEqual({
      state: 'active',
      slug: 'storify',
    });
    expect(stub.calls).toHaveLength(3);
  });

  it('lists the mock fixtures when GITHUB_MOCK=true (local only)', async () => {
    await seedProject('team-console', 'geeera/team-console');
    const response = await fetchApi(PATH, localEnv({ GITHUB_MOCK: 'true' }), { github: new ApiGitHub() });
    const body = await bodyOf(response);
    expect(body.repositories).toEqual([
      { fullName: 'geeera/no-yml', private: true, registration: { state: 'none' } },
      { fullName: 'geeera/private-product', private: true, registration: { state: 'none' } },
      {
        fullName: 'geeera/team-console',
        private: false,
        registration: { state: 'active', slug: 'team-console' },
      },
    ]);
    expect(body.selectionUrl).toBe('https://github.com/settings/installations/1001');
  });

  it('is a read the dev service identity may make (not behind the owner-only connection routes)', async () => {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
    });
    const stub = listStub();
    const response = await fetchApi(PATH, accessEnv(teamDomain), {
      github: new ApiGitHub({ fetch: stub.fetch }),
      ownerConnection: CONNECTED,
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(response.status).toBe(200);
    vi.restoreAllMocks();
  });
});

describe('readInstallationList: the subrequest budget', () => {
  const connect = (stub: ListStub) => new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());

  it('keeps the pages read when the budget stops the list after page 2: partial, 200 repositories', async () => {
    const stub = listStub({ repos: manyRepos(450) });
    // lookup 1 + cold mint 1 + two pages = 4.
    const read = await readInstallationList(await connect(stub), OWNER_ID, { budget: 4, maxPages: 10 });
    expect(read.repositories).toHaveLength(200);
    expect(read.partial).toBe(true);
    expect(stub.listReads()).toBe(2);
  });

  it('fails with github-request-budget when the budget ends before the first page', async () => {
    const stub = listStub();
    await expect(
      readInstallationList(await connect(stub), OWNER_ID, { budget: 2, maxPages: 10 }),
    ).rejects.toMatchObject({
      problem: { type: 'github-request-budget', status: 503 },
    });
    expect(stub.listReads()).toBe(0);
  });
});
