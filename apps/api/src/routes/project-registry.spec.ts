import { env } from 'cloudflare:test';
import {
  PROBLEM_TYPE_PREFIX,
  isProblemDetails,
  type ProjectDto,
  type ProjectSetupDto,
} from '@shared/contracts';
import { MemoryReadCache } from '@worker/github';
import { ApiGitHub } from '../github';
import { fetchApi, type ApiRequest } from '../testing/access-kit';
import {
  INSTALLATION_ID,
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
  type ReadHandler,
  type StubGitHub,
} from '../testing/github-kit';
import { fakeGitHub, resetOwnerConnections, seedConnection } from '../testing/owner-kit';
import { seedMembership, seedSessionUser, sendAsSession } from '../testing/session-kit';
import { AuditRepo, InstallationsRepo } from '@worker/db';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';

// The #59 fixtures are sealed for `local`, so session users run on the local bindings without the bypass.
const SESSION_ENV = () => localEnv({ AUTH_MODE: undefined });

/** `GET /repos/{repo}` with the id GitHub reports (ADR 0008: `projects.repo_id` is recorded from it). */
function repoWithId(fullName: string, id: number) {
  return () => json(200, { full_name: fullName, id, private: true, default_branch: 'main', owner: OWNER });
}

// #15 acceptance criteria: the registry's routes against a scripted GitHub and the pool's D1.

const OWNER = { login: 'geeera', id: 100001 };
const PROJECT_YML = 'name: Storify\nowner:\n  language: en   # owner-facing copy\n  timezone: Europe/Kyiv\n';
const INSTALL_URL = 'https://github.com/apps/team-console-local/installations/new';

interface RepoScript {
  /** `GET /repos/{repo}`; `full_name` defaults to the requested path's spelling. */
  readonly repository?: (call: GitHubCall) => Response;
  /** `GET /repos/{repo}/contents/.product-team/project.yml`. */
  readonly projectYml?: (call: GitHubCall) => Response;
}

function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const ymlFile = (text: string) => () =>
  json(200, { type: 'file', encoding: 'base64', path: '.product-team/project.yml', content: base64(text) });

/** A stable id per requested repository (case-insensitive, as GitHub's), so distinct repositories never collide. */
function repoIdFor(path: string): number {
  let hash = 7;
  for (const char of path.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return 700_000 + hash;
}

function repoOwnedBy(owner: { login: string; id: number }, fullName?: string) {
  return (call: GitHubCall) =>
    json(200, {
      full_name: fullName ?? decodeURIComponent(call.url.pathname.slice('/repos/'.length)),
      id: repoIdFor(decodeURIComponent(call.url.pathname.slice('/repos/'.length))),
      private: true,
      default_branch: 'main',
      owner,
    });
}

function reads(script: RepoScript = {}): ReadHandler {
  return (call) => {
    if (call.url.pathname.endsWith('/contents/.product-team/project.yml')) {
      return (script.projectYml ?? ymlFile(PROJECT_YML))(call);
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(call.url.pathname)) {
      return (script.repository ?? repoOwnedBy(OWNER))(call);
    }
    return json(404, { message: 'Not Found' });
  };
}

interface Harness {
  readonly stub: StubGitHub;
  readonly github: ApiGitHub;
}

function harness(script: RepoScript = {}, installation?: () => Response): Harness {
  const stub = stubGitHub(reads(script), installation);
  return { stub, github: new ApiGitHub({ fetch: stub.fetch }) };
}

const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
const ownerEnv = (overrides: Parameters<typeof localEnv>[0] = {}) => localEnv(overrides);

async function add(
  body: unknown,
  h: Harness = harness(),
  bindings = ownerEnv(),
  extra: Partial<ApiRequest> = {},
): Promise<Response> {
  return fetchApi('/api/v1/projects', bindings, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    github: h.github,
    ...extra,
  });
}

async function problemOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem body: ${JSON.stringify(body)}`);
  }
  return body as unknown as Record<string, unknown>;
}

async function expectProblem(
  response: Response,
  status: number,
  type: string,
  members: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  const body = await problemOf(response);
  expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}${type}`, status, ...members });
  return body;
}

async function rowCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM projects').first<{ n: number }>();
  return row?.n ?? -1;
}

// The owner is the #59 connection in D1: every case starts connected as the fixtures' owner, with the id pinned.
beforeEach(async () => {
  await resetProjects();
  await resetOwnerConnections();
  await seedConnection(fakeGitHub(), { user: OWNER });
});

describe('GET /api/v1/projects', () => {
  it('answers an empty list on a fresh registry', async () => {
    const response = await fetchApi('/api/v1/projects', localEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('lists active projects only; ?include=archived adds the archived ones after them', async () => {
    await seedProject('active', 'geeera/active');
    await seedProject('gone', 'geeera/gone');
    await env.DB.prepare('UPDATE projects SET archived_at = ?1 WHERE slug = ?2')
      .bind('2026-09-30T12:00:00Z', 'gone')
      .run();

    const active = (await (await fetchApi('/api/v1/projects', localEnv())).json()) as ProjectDto[];
    expect(active).toEqual([
      {
        slug: 'active',
        repo: 'geeera/active',
        displayName: 'active',
        routineId: null,
        addedAt: '2026-09-30T00:00:00Z',
        archivedAt: null,
        slots: { pm: 'missing', dev: 'missing', qa: 'missing' },
        snooze: { snoozed: false },
        tracker: 'github',
        keyPrefix: null,
      },
    ]);

    const all = (await (
      await fetchApi('/api/v1/projects?include=archived', localEnv())
    ).json()) as ProjectDto[];
    expect(all.map((project) => [project.slug, project.archivedAt])).toEqual([
      ['active', null],
      ['gone', '2026-09-30T12:00:00Z'],
    ]);
  });
});

describe('GET /api/v1/projects — tracker (#435)', () => {
  it('says which projects moved to the console tracker and their key prefix', async () => {
    await seedProject('on-github', 'geeera/on-github');
    await seedProject('on-console', 'geeera/on-console');
    // The columns only: `switchTracker` also seeds labels, which would keep `resetProjects` from deleting the row.
    await env.DB.prepare(
      "UPDATE projects SET tracker = 'console', key_prefix = 'OC' WHERE slug = 'on-console'",
    ).run();
    const body = (await (await fetchApi('/api/v1/projects', localEnv())).json()) as ProjectDto[];
    expect(body.map((project) => [project.slug, project.tracker, project.keyPrefix])).toEqual([
      ['on-console', 'console', 'OC'],
      ['on-github', 'github', null],
    ]);
  });
});

describe('POST /api/v1/projects — success', () => {
  it('validates against GitHub, then stores the row with the installation id (201)', async () => {
    const h = harness({ repository: repoOwnedBy(OWNER, 'geeera/Storify') });

    const response = await add({ repo: 'geeera/storify', displayName: 'Storify' }, h);

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/api/v1/projects/storify');
    const body = (await response.json()) as ProjectDto;
    expect(body).toMatchObject({
      slug: 'storify',
      repo: 'geeera/Storify',
      displayName: 'Storify',
      routineId: null,
      archivedAt: null,
    });
    expect(Date.parse(body.addedAt)).not.toBeNaN();

    const row = await env.DB.prepare(
      'SELECT repo, installation_id, cache_epoch FROM projects WHERE slug = ?1',
    )
      .bind('storify')
      .first();
    expect(row).toEqual({ repo: 'geeera/Storify', installation_id: INSTALLATION_ID, cache_epoch: 0 });

    // The app-installed check comes first and uses the app JWT; the reads use the downscoped token.
    expect(h.stub.calls[0]?.url.pathname).toBe('/repos/geeera/storify/installation');
    expect(h.stub.reads().map((call) => call.url.pathname)).toEqual([
      '/repos/geeera/storify',
      '/repos/geeera/storify/contents/.product-team/project.yml',
    ]);
    expect(
      h.stub
        .reads()
        .every((call) => call.headers.get('authorization')?.startsWith(`Bearer ${TOKEN_SENTINEL}`)),
    ).toBe(true);
  });

  it('derives the slug and the display name from the repository name', async () => {
    const response = await add({ repo: 'geeera/My_Product.js' });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      slug: 'my-product-js',
      displayName: 'My_Product.js',
    });
  });

  it('accepts an explicit slug and compares the owner login case-insensitively', async () => {
    const h = harness({ repository: repoOwnedBy({ login: 'GeeEra', id: OWNER.id }) });
    const response = await add({ repo: 'GeeEra/storify', slug: 'story' }, h);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ slug: 'story' });
  });

  it('checks the user id pinned by the #59 connection, not only the login', async () => {
    const ok = await add({ repo: 'geeera/storify' }, harness());
    expect(ok.status).toBe(201);

    const h = harness({ repository: repoOwnedBy({ login: 'geeera', id: 999 }) });
    const renamedAccount = await add({ repo: 'geeera/other' }, h);
    await expectProblem(renamedAccount, 409, 'github-owner-mismatch', { step: 'repo-owner' });
    expect(await rowCount()).toBe(1);
  });
});

describe('POST /api/v1/projects — refusals save nothing', () => {
  it.each([
    ['not an object', '"geeera/storify"', 'repo-format'],
    ['malformed JSON', '{"repo":', 'repo-format'],
    ['no repo', {}, 'repo-format'],
    ['a repo without owner', { repo: 'storify' }, 'repo-format'],
    ['a path-like repo', { repo: '../../app/installations' }, 'repo-format'],
    ['a repo with a third segment', { repo: 'geeera/storify/issues' }, 'repo-format'],
    ['a repo with a space', { repo: 'geeera/story fy' }, 'repo-format'],
    ['a repo named ..', { repo: 'geeera/..' }, 'repo-format'],
    ['an unknown member', { repo: 'geeera/storify', admin: true }, 'repo-format'],
    ['a slug that is not a string', { repo: 'geeera/storify', slug: 7 }, 'slug'],
    ['an upper-case slug', { repo: 'geeera/storify', slug: 'Story' }, 'slug'],
    ['a one-letter slug', { repo: 'geeera/storify', slug: 's' }, 'slug'],
    ['a slug with a slash', { repo: 'geeera/storify', slug: 'a/b' }, 'slug'],
    ['a derived slug that is too short', { repo: 'geeera/x' }, 'slug'],
    ['an empty display name', { repo: 'geeera/storify', displayName: '  ' }, 'display-name'],
    ['a display name with controls', { repo: 'geeera/storify', displayName: 'a\u202eb' }, 'display-name'],
    ['a display name with a newline', { repo: 'geeera/storify', displayName: 'a\nb' }, 'display-name'],
    ['a long display name', { repo: 'geeera/storify', displayName: 'x'.repeat(81) }, 'display-name'],
  ] as const)('%s → 422 validation before any GitHub call', async (_label, body, step) => {
    const h = harness();
    await expectProblem(await add(body, h), 422, 'validation', { step });
    expect(h.stub.calls).toHaveLength(0);
    expect(await rowCount()).toBe(0);
  });

  // The ADR 0008 system slugs (`owner`, `admin`, …) join the console routes (#465).
  it.each(['needs-you', 'overview', 'settings', 'api', 'owner', 'admin', 'accounts', 'runner'])(
    'reserved slug %s → 422, given or derived',
    async (slug) => {
      const h = harness();
      await expectProblem(await add({ repo: 'geeera/storify', slug }, h), 422, 'validation', {
        step: 'slug',
      });
      await expectProblem(await add({ repo: `geeera/${slug}` }, h), 422, 'validation', { step: 'slug' });
      expect(h.stub.calls).toHaveLength(0);
      expect(await rowCount()).toBe(0);
    },
  );

  it('a body over 4 KB → 413 before parsing', async () => {
    const h = harness();
    const response = await add({ repo: 'geeera/storify', displayName: 'x'.repeat(5000) }, h);
    await expectProblem(response, 413, 'payload-too-large');
    expect(h.stub.calls).toHaveLength(0);
  });

  it.each([
    ['the slug', { repo: 'geeera/another', slug: 'storify' }],
    ['the repository in another case', { repo: 'GEEERA/Storify', slug: 'another' }],
  ])('a duplicate of %s → 409 project-exists before any GitHub call', async (_label, body) => {
    await seedProject('storify', 'geeera/storify');
    const h = harness();
    await expectProblem(await add(body, h), 409, 'project-exists', { step: 'unique' });
    expect(h.stub.calls).toHaveLength(0);
    expect(await rowCount()).toBe(1);
  });

  it('an archived project still holds its slug and repository (restoring is out of scope)', async () => {
    await seedProject('storify', 'geeera/storify');
    await env.DB.prepare("UPDATE projects SET archived_at = '2026-09-30T01:00:00Z'").run();
    const body = await expectProblem(await add({ repo: 'geeera/storify' }), 409, 'project-exists');
    expect(body['detail']).toMatch(/archived/);
  });

  it('app not installed → 409 github-app-not-installed with the install URL, step app-installed', async () => {
    const h = harness({}, () => json(404, { message: 'Not Found' }));
    await expectProblem(await add({ repo: 'geeera/no-app' }, h), 409, 'github-app-not-installed', {
      step: 'app-installed',
      installUrl: INSTALL_URL,
      detail: 'Install the team-console app on geeera/no-app',
    });
    expect(h.stub.minted()).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  it('no connected account → 403 github-owner-not-connected with connectUrl, step repo-owner', async () => {
    const h = harness();
    await resetOwnerConnections();
    await expectProblem(await add({ repo: 'geeera/storify' }, h), 403, 'github-owner-not-connected', {
      step: 'repo-owner',
      connectUrl: '/api/v1/github/connect',
    });
    expect(h.stub.reads()).toHaveLength(0);
    expect(await rowCount()).toBe(0);
  });

  it('a connection the Worker cannot use (rotated key) counts as not connected', async () => {
    await env.DB.prepare("UPDATE owner_connections SET key_id = '00000000'").run();
    const response = await add({ repo: 'geeera/storify' }, harness());
    await expectProblem(response, 403, 'github-owner-not-connected');
  });

  it('a repository of another account → 409 github-owner-mismatch, step repo-owner', async () => {
    const h = harness({ repository: repoOwnedBy({ login: 'acme', id: 200001 }) });
    const body = await expectProblem(await add({ repo: 'acme/site' }, h), 409, 'github-owner-mismatch', {
      step: 'repo-owner',
    });
    expect(body['detail']).toBe('acme/site is owned by acme, not by the connected account geeera');
    expect(body).toMatchObject({ repoOwner: 'acme', login: 'geeera' });
    expect(h.stub.reads().map((call) => call.url.pathname)).toEqual(['/repos/acme/site']);
    expect(await rowCount()).toBe(0);
  });

  it.each([
    ['404', () => json(404, { message: 'Not Found' })],
    ['a directory', () => json(200, [{ name: 'x' }])],
  ])(
    'project.yml answered with %s → 422 project-yml-missing, step project-yml',
    async (_label, projectYml) => {
      const h = harness({ projectYml });
      await expectProblem(await add({ repo: 'geeera/storify' }, h), 422, 'project-yml-missing', {
        step: 'project-yml',
      });
      expect(await rowCount()).toBe(0);
    },
  );

  it('GitHub failures keep #9 mapping and name the step they happened in', async () => {
    const lookupDown = harness({}, () => json(401, {}));
    await expectProblem(await add({ repo: 'geeera/storify' }, lookupDown), 503, 'github-auth', {
      step: 'app-installed',
    });
    expect(
      (await problemOf(await add({ repo: 'geeera/storify' }, lookupDown)))['installUrl'],
    ).toBeUndefined();

    const limited = harness({ repository: () => json(429, {}, { 'retry-after': '42' }) });
    const rateLimited = await add({ repo: 'geeera/storify' }, limited);
    expect(rateLimited.headers.get('retry-after')).toBe('42');
    await expectProblem(rateLimited, 429, 'github-rate-limit', { step: 'repo-owner' });

    const ymlDown = harness({ projectYml: () => json(503, {}) });
    await expectProblem(await add({ repo: 'geeera/storify' }, ymlDown), 502, 'github-unavailable', {
      step: 'project-yml',
    });
    expect(await rowCount()).toBe(0);
  });

  it('refuses a cross-site write before anything else (#8)', async () => {
    const h = harness();
    const response = await add({ repo: 'geeera/storify' }, h, ownerEnv(), {
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    });
    await expectProblem(response, 403, 'csrf');
    expect(h.stub.calls).toHaveLength(0);
  });
});

describe('PATCH /api/v1/projects/:slug', () => {
  const patch = async (slug: string, body: unknown) =>
    fetchApi(`/api/v1/projects/${slug}`, localEnv(), {
      method: 'PATCH',
      headers: WRITE_HEADERS,
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    await seedProject('storify', 'geeera/storify');
  });

  it('changes the display name and the routine id, and clears the routine id with null', async () => {
    await expect(
      (await patch('storify', { displayName: 'Storify', routineId: 'trig_01AbC' })).json(),
    ).resolves.toMatchObject({ slug: 'storify', displayName: 'Storify', routineId: 'trig_01AbC' });
    await expect((await patch('storify', { routineId: null })).json()).resolves.toMatchObject({
      displayName: 'Storify',
      routineId: null,
    });
  });

  it.each([
    ['an empty body', {}],
    ['an unknown member', { repo: 'geeera/other' }],
    ['a routine id of another shape', { routineId: 'https://evil.example' }],
    ['an empty display name', { displayName: '' }],
  ])('%s → 422 validation, nothing changed', async (_label, body) => {
    await expectProblem(await patch('storify', body), 422, 'validation');
    const row = await env.DB.prepare('SELECT repo, display_name FROM projects').first();
    expect(row).toEqual({ repo: 'geeera/storify', display_name: 'storify' });
  });

  it('an unknown slug → 404 project-not-found', async () => {
    await expectProblem(await patch('nope', { displayName: 'x' }), 404, 'project-not-found');
  });
});

describe('POST /api/v1/projects/:slug/archive', () => {
  it('archives (204); the project is then 404 project-not-found on every project route', async () => {
    await seedProject('storify', 'geeera/storify');
    const h = harness();
    const archive = await fetchApi('/api/v1/projects/storify/archive', localEnv(), {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      github: h.github,
    });
    expect(archive.status).toBe(204);
    await expect(archive.text()).resolves.toBe('');

    await expect((await fetchApi('/api/v1/projects', localEnv())).json()).resolves.toEqual([]);
    for (const [method, path] of [
      ['GET', '/api/v1/projects/storify/setup'],
      ['GET', '/api/v1/projects/storify/repository'],
      ['PATCH', '/api/v1/projects/storify'],
      ['POST', '/api/v1/projects/storify/archive'],
    ] as const) {
      const response = await fetchApi(path, localEnv(), {
        method,
        headers: WRITE_HEADERS,
        ...(method === 'PATCH' ? { body: '{"displayName":"x"}' } : {}),
        github: h.github,
      });
      await expectProblem(response, 404, 'project-not-found');
    }
    expect(h.stub.calls).toHaveLength(0);
  });
});

describe('GET /api/v1/projects/:slug/setup', () => {
  const setup = async (h: Harness, bindings = ownerEnv(), query = '', extra: Partial<ApiRequest> = {}) =>
    fetchApi(`/api/v1/projects/storify/setup${query}`, bindings, { github: h.github, ...extra });

  beforeEach(async () => {
    await seedProject('storify', 'geeera/storify');
  });

  it('reports every step of a ready project', async () => {
    const response = await setup(harness());
    expect(response.status).toBe(200);
    const body: ProjectSetupDto = await response.json();
    expect(body).toEqual({
      appInstalled: 'ok',
      repoOwner: 'ok',
      projectYml: 'ok',
      events: 'never',
      lastEventAt: null,
      routineToken: 'missing',
      connection: { state: 'connected', login: 'geeera' },
      accessLostAt: null,
      ownerLanguage: 'en',
      repoOwnerLogin: 'geeera',
    });
  });

  it('app missing: nothing else can be read, and the server builds the install URL (#83)', async () => {
    const h = harness({}, () => json(404, { message: 'Not Found' }));
    await expect((await setup(h)).json()).resolves.toMatchObject({
      appInstalled: 'missing',
      repoOwner: 'not-checked',
      projectYml: 'missing',
      ownerLanguage: 'ru',
      installUrl: INSTALL_URL,
    });
    expect(h.stub.reads()).toHaveLength(0);
  });

  it('app ok: no installUrl member', async () => {
    const body = (await (await setup(harness())).json()) as Record<string, unknown>;
    expect(body['installUrl']).toBeUndefined();
  });

  it('owner of another account → mismatch; no connection → not-checked and not-connected', async () => {
    const other = harness({ repository: repoOwnedBy({ login: 'acme', id: 200001 }) });
    await expect((await setup(other)).json()).resolves.toMatchObject({
      repoOwner: 'mismatch',
      repoOwnerLogin: 'acme',
    });

    await resetOwnerConnections();
    const unconnected = await setup(harness(), localEnv());
    await expect(unconnected.json()).resolves.toMatchObject({
      repoOwner: 'not-checked',
      connection: { state: 'not-connected' },
    });
  });

  it('project.yml missing → missing, language ru; a file without owner.language → ru', async () => {
    await expect((await setup(harness({ projectYml: () => json(404, {}) }))).json()).resolves.toMatchObject({
      projectYml: 'missing',
      ownerLanguage: 'ru',
    });
    await expect((await setup(harness({ projectYml: ymlFile('name: x\n') }))).json()).resolves.toMatchObject({
      projectYml: 'ok',
      ownerLanguage: 'ru',
    });
  });

  it('routine token: present when ROUTINE_TOKEN_<SLUG> is set, and its value never appears', async () => {
    await seedProject('my-app', 'geeera/my-app');
    const secret = ['routine', 'SENTINEL', 'value'].join('-');
    const response = await fetchApi(
      '/api/v1/projects/my-app/setup',
      ownerEnv({ ROUTINE_TOKEN_MY_APP: secret }),
      {
        github: harness().github,
      },
    );
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ routineToken: 'present' });
    expect(text).not.toContain(secret);

    await expect(
      (await setup(harness(), ownerEnv({ ROUTINE_TOKEN_MY_APP: secret }))).json(),
    ).resolves.toMatchObject({ routineToken: 'missing' });
  });

  it('events: never before a delivery, seen with the last delivery time once one is recorded (#83)', async () => {
    await expect((await setup(harness())).json()).resolves.toMatchObject({
      events: 'never',
      lastEventAt: null,
    });
    const insert =
      'INSERT INTO webhook_deliveries (delivery_id, event, repo, body_sha256, received_at) VALUES (?1, ?2, ?3, ?1, ?4)';
    try {
      await env.DB.prepare(insert).bind('d1', 'push', 'Geeera/Storify', '2026-09-30T00:00:00Z').run();
      await expect((await setup(harness())).json()).resolves.toMatchObject({
        events: 'seen',
        lastEventAt: '2026-09-30T00:00:00Z',
      });
      await env.DB.prepare(insert).bind('d2', 'issues', 'geeera/storify', '2026-09-30T05:00:00Z').run();
      await expect((await setup(harness())).json()).resolves.toMatchObject({
        events: 'seen',
        lastEventAt: '2026-09-30T05:00:00Z',
      });
    } finally {
      await env.DB.prepare('DELETE FROM webhook_deliveries').run();
    }
  });

  it('caches the GitHub part; ?fresh=1 checks again and refreshes the cache', async () => {
    let installed = false;
    const stub = stubGitHub(reads(), () => (installed ? json(200, { id: INSTALLATION_ID }) : json(404, {})));
    const h = { stub, github: new ApiGitHub({ fetch: stub.fetch, readCache: new MemoryReadCache() }) };

    await expect((await setup(h)).json()).resolves.toMatchObject({ appInstalled: 'missing' });
    installed = true;
    const callsBefore = stub.calls.length;
    await expect((await setup(h)).json()).resolves.toMatchObject({ appInstalled: 'missing' });
    expect(stub.calls).toHaveLength(callsBefore);

    await expect((await setup(h, ownerEnv(), '?fresh=1')).json()).resolves.toMatchObject({
      appInstalled: 'ok',
    });
    await expect((await setup(h)).json()).resolves.toMatchObject({ appInstalled: 'ok' });
  });

  describe('a GitHub failure marks only its own step unknown (#83), not the whole request', () => {
    it('the app-installed lookup fails → appInstalled, repoOwner and projectYml all unknown; events/routineToken still answer', async () => {
      const h = harness({}, () => json(503, {}));
      const response = await setup(h);
      expect(response.status).toBe(200);
      expect(response.headers.get('retry-after')).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        appInstalled: 'unknown',
        repoOwner: 'unknown',
        projectYml: 'unknown',
        events: 'never',
        routineToken: 'missing',
      });
      expect(h.stub.reads()).toHaveLength(0);
    });

    it('the repository read fails → repoOwner unknown only; project.yml still reads', async () => {
      const h = harness({ repository: () => json(429, {}, { 'retry-after': '5' }) });
      const response = await setup(h);
      expect(response.status).toBe(200);
      expect(response.headers.get('retry-after')).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        appInstalled: 'ok',
        repoOwner: 'unknown',
        projectYml: 'ok',
        ownerLanguage: 'en',
      });
    });

    it('the project.yml read fails → projectYml unknown only; the repo owner still reads', async () => {
      const h = harness({ projectYml: () => json(502, {}) });
      const response = await setup(h);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        appInstalled: 'ok',
        repoOwner: 'ok',
        projectYml: 'unknown',
        ownerLanguage: 'ru',
      });
    });
  });

  it('accessLostAt: null while the app has access, then the time it lost it (#12)', async () => {
    await expect((await setup(harness())).json()).resolves.toMatchObject({ accessLostAt: null });
    await env.DB.prepare(
      "UPDATE projects SET access_lost_at = '2026-09-30T09:00:00Z' WHERE slug = 'storify'",
    ).run();
    await expect((await setup(harness())).json()).resolves.toMatchObject({
      accessLostAt: '2026-09-30T09:00:00Z',
    });
  });
});

// #466 (ADR 0008 decisions 1, 2, 4 and 5): a project is created in an admitted account, its installation is linked
// to that account, the repository id is recorded, and the action is audited with ids only.
describe('POST /api/v1/projects — the account (#466)', () => {
  it('creates in the environment owner’s account, links the installation and audits it', async () => {
    const h = harness({ repository: repoWithId('geeera/storify', 860123) });
    const response = await add({ repo: 'geeera/storify' }, h);
    expect(response.status).toBe(201);

    const row = await env.DB.prepare('SELECT account_id, repo_id FROM projects WHERE slug = ?1')
      .bind('storify')
      .first();
    expect(row).toEqual({ account_id: OWNER_ACCOUNT_ID, repo_id: 860123 });
    await expect(
      new InstallationsRepo(env.DB).findLinked('github', String(INSTALLATION_ID)),
    ).resolves.toMatchObject({ accountId: OWNER_ACCOUNT_ID, accountLogin: 'geeera' });
    const audit = await new AuditRepo(env.DB).listForAccount(OWNER_ACCOUNT_ID, null, 10);
    expect(audit.events[0]).toMatchObject({
      kind: 'project.created',
      target: 'storify',
      actorKind: 'user',
      details: { repoId: 860123, installationId: INSTALLATION_ID },
    });
  });

  // #482 security review item 3: the add judges repository ownership against the environment owner's connection
  // and mints with the environment's app, so until T-4 a session user — owner or member of any account — is
  // refused before anything is read or linked.
  it.each(['owner', 'member'] as const)(
    'a session %s of another account is refused with 403 owner-only, nothing written, nothing linked',
    async (role) => {
      const user = await seedSessionUser(role);
      const h = harness();
      const response = await sendAsSession(
        user,
        'POST',
        '/api/v1/projects',
        { repo: 'geeera/storify' },
        { github: h.github },
        SESSION_ENV(),
      );
      await expectProblem(response, 403, 'owner-only');
      expect(h.stub.calls).toHaveLength(0);
      expect(await rowCount()).toBe(0);
      await expect(
        new InstallationsRepo(env.DB).findLinked('github', String(INSTALLATION_ID)),
      ).resolves.toBeNull();
    },
  );

  it('accountId must name one of the caller’s own accounts (the Access owner linked to several, T-3)', async () => {
    // The Access owner owns the owner account by construction; a body naming another account is refused.
    const stranger = await seedSessionUser('owner');
    const elsewhere = await add({ repo: 'geeera/storify', accountId: stranger.account.id }, harness());
    await expectProblem(elsewhere, 403, 'account-owner-only');
    expect(await rowCount()).toBe(0);
    const malformed = await add({ repo: 'geeera/storify', accountId: 'nope' }, harness());
    await expectProblem(malformed, 422, 'validation');
    const own = await add({ repo: 'geeera/storify', accountId: OWNER_ACCOUNT_ID }, harness());
    expect(own.status).toBe(201);
  });

  it('refuses a repository of an installation linked to another account (409 installation-other-account)', async () => {
    const other = await seedSessionUser('owner');
    await new InstallationsRepo(env.DB).link({
      accountId: other.account.id,
      provider: 'github',
      installationId: String(INSTALLATION_ID),
      accountLogin: 'geeera',
      linkedByUserId: null,
      at: '2026-11-10T00:00:00.000Z',
    });
    const response = await add({ repo: 'geeera/storify' }, harness());
    await expectProblem(response, 409, 'installation-other-account', { step: 'app-installed' });
    expect(await rowCount()).toBe(0);
  });

  // #484: webhooks route by the repository id only, so a row without one would be unreachable.
  it('refuses to create a project when GitHub reports no repository id (502, nothing written or linked)', async () => {
    const noId = () =>
      json(200, { full_name: 'geeera/storify', private: true, default_branch: 'main', owner: OWNER });
    const response = await add({ repo: 'geeera/storify' }, harness({ repository: noId }));
    await expectProblem(response, 502, 'github-unexpected', { step: 'repo-owner' });
    expect(await rowCount()).toBe(0);
    await expect(
      new InstallationsRepo(env.DB).findLinked('github', String(INSTALLATION_ID)),
    ).resolves.toBeNull();
  });

  it('answers 409 repo-taken, not 500, when the repository id is already held under another name', async () => {
    expect(
      (await add({ repo: 'geeera/first' }, harness({ repository: repoWithId('geeera/first', 860777) })))
        .status,
    ).toBe(201);
    // The same GitHub repository id reached through another name: the pre-check by name passes, the id does not.
    const response = await add(
      { repo: 'geeera/second' },
      harness({ repository: repoWithId('geeera/second', 860777) }),
    );
    await expectProblem(response, 409, 'repo-taken', { step: 'unique' });
    expect(await rowCount()).toBe(1);
  });

  it('audits an update and an archive with ids and enums only', async () => {
    await seedProject('storify', 'geeera/storify');
    const h = harness();
    const updated = await fetchApi('/api/v1/projects/storify', ownerEnv(), {
      method: 'PATCH',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ displayName: `Name ghp_${'x'.repeat(36)}` }),
      github: h.github,
    });
    expect(updated.status).toBe(200);
    const archived = await fetchApi('/api/v1/projects/storify/archive', ownerEnv(), {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      github: h.github,
    });
    expect(archived.status).toBe(204);

    const audit = await new AuditRepo(env.DB).listForAccount(OWNER_ACCOUNT_ID, null, 10);
    expect(audit.events.slice(0, 2).map((event) => [event.kind, event.target, event.details])).toEqual([
      ['project.archived', 'storify', {}],
      ['project.updated', 'storify', { fields: ['displayName'] }],
    ]);
    // The text itself never reaches the audit row — only which field changed.
    expect(JSON.stringify(audit.events)).not.toContain('ghp_');
  });

  // #482 security review item 1: renaming and archiving (one-way) are the account owner's, never a member's.
  it('a session member of the account cannot update or archive its project (403 account-owner-only)', async () => {
    await seedProject('storify', 'geeera/storify');
    const member = await seedSessionUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, member.userId, 'member');
    const updated = await sendAsSession(
      member,
      'PATCH',
      '/api/v1/projects/storify',
      { displayName: 'x' },
      {},
      SESSION_ENV(),
    );
    await expectProblem(updated, 403, 'account-owner-only');
    const archived = await sendAsSession(
      member,
      'POST',
      '/api/v1/projects/storify/archive',
      {},
      {},
      SESSION_ENV(),
    );
    await expectProblem(archived, 403, 'account-owner-only');
    const row = await env.DB.prepare('SELECT display_name, archived_at FROM projects WHERE slug = ?1')
      .bind('storify')
      .first();
    expect(row).toEqual({ display_name: 'storify', archived_at: null });
    // A session owner of the account may.
    const owner = await seedSessionUser('owner');
    await seedMembership(OWNER_ACCOUNT_ID, owner.userId, 'owner');
    const renamed = await sendAsSession(
      owner,
      'PATCH',
      '/api/v1/projects/storify',
      { displayName: 'Renamed' },
      {},
      SESSION_ENV(),
    );
    expect(renamed.status).toBe(200);
    expect(
      (await sendAsSession(owner, 'POST', '/api/v1/projects/storify/archive', {}, {}, SESSION_ENV())).status,
    ).toBe(204);
  });

  it('a session user of another account cannot update or archive the owner’s project (404)', async () => {
    await seedProject('storify', 'geeera/storify');
    const other = await seedSessionUser('owner');
    const updated = await sendAsSession(
      other,
      'PATCH',
      '/api/v1/projects/storify',
      { displayName: 'x' },
      {},
      SESSION_ENV(),
    );
    await expectProblem(updated, 404, 'project-not-found');
    const archived = await sendAsSession(
      other,
      'POST',
      '/api/v1/projects/storify/archive',
      {},
      {},
      SESSION_ENV(),
    );
    await expectProblem(archived, 404, 'project-not-found');
    expect(await rowCount()).toBe(1);
  });
});

describe('no secret in any registry response (#15 AC)', () => {
  const FORBIDDEN = ['ROUTINE_TOKEN', 'ghs_', 'ghu_', 'ghr_', 'PRIVATE KEY', TOKEN_SENTINEL];

  it('list, add (success and every refusal), update, setup and archive bodies carry none of them', async () => {
    const secret = ['routine', 'SENTINEL', 'value'].join('-');
    const bindings = ownerEnv({ ROUTINE_TOKEN_STORIFY: secret });
    const bodies: string[] = [];
    const record = async (response: Response) => {
      bodies.push(await response.text());
    };

    await record(await add({ repo: 'geeera/storify' }, harness(), bindings));
    await record(
      await add(
        { repo: 'geeera/no-app' },
        harness({}, () => json(404, {})),
        bindings,
      ),
    );
    await record(
      await add(
        { repo: 'acme/site' },
        harness({ repository: repoOwnedBy({ login: 'acme', id: 2 }) }),
        bindings,
      ),
    );
    await record(
      await add({ repo: 'geeera/no-yml' }, harness({ projectYml: () => json(404, {}) }), bindings),
    );
    await record(await add({ repo: 'geeera/x' }, harness(), bindings));
    await record(await add({ repo: 'geeera/storify' }, harness(), bindings));
    await record(await fetchApi('/api/v1/projects?include=archived', bindings));
    await record(
      await fetchApi('/api/v1/projects/storify', bindings, {
        method: 'PATCH',
        headers: WRITE_HEADERS,
        body: '{"routineId":"trig_1"}',
      }),
    );
    await record(await fetchApi('/api/v1/projects/storify/setup', bindings, { github: harness().github }));
    await record(
      await fetchApi('/api/v1/projects/storify/archive', bindings, {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      }),
    );

    expect(bodies).toHaveLength(10);
    expect(JSON.parse(bodies[8] ?? '{}')).toMatchObject({ routineToken: 'present' });
    for (const body of bodies) {
      for (const forbidden of [...FORBIDDEN, secret]) {
        expect(body.includes(forbidden), `${body} contains ${forbidden}`).toBe(false);
      }
    }
  });
});
