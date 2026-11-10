import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createApiApp } from '../app';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { json, localEnv, stubGitHub } from '../testing/github-kit';
import { seedAccountProject, seedSessionUser, sendAsSession, type SessionUser } from '../testing/session-kit';
import { jobActor, newKey, seedTrackerProject, send, sendAsService } from '../testing/tracker-kit';
import { ROUTE_SCOPES, routeScopeOf, type ScopeRule, type ScopedRoute } from './route-scope';

// ADR 0008 decision 2, threat model C9 (#466): every route registered on the Hono app declares a scope rule, and the
// rule holds — a second account sees nothing of the first across every route, and a route added without a row fails
// here before it ships. RR12: the chokepoint is this spec plus `projects/lookup.ts`.

function normalised(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

const registered: readonly string[] = [
  ...new Set(
    createApiApp()
      .routes.filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/'))
      .map((route) => `${route.method} ${normalised(route.path)}`),
  ),
];

const ofRule = (rule: ScopeRule): ScopedRoute[] =>
  (Object.keys(ROUTE_SCOPES) as ScopedRoute[]).filter((route) => ROUTE_SCOPES[route] === rule);

/** The problem slug of a JSON problem answer; `null` for anything else (a 204, a file, a plain body). */
async function slugOf(response: Response): Promise<string | null> {
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    return null;
  }
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

/** A GitHub that answers nothing, so a route that reaches it fails fast and never with a project's data. */
const github = () => new ApiGitHub({ fetch: stubGitHub(() => json(404, { message: 'Not Found' })).fetch });

function concrete(route: string, slug: string): { method: string; path: string } {
  const [method = '', pattern = ''] = route.split(' ');
  return { method, path: pattern.replace(':slug', slug).replace(/:[a-z]+/g, '1') };
}

describe('the deny-by-default route inventory', () => {
  it('finds the registered routes (the inventory is not vacuous)', () => {
    expect(registered).toEqual(
      expect.arrayContaining([
        'GET /api/v1/needs-you',
        'GET /api/v1/overview',
        'GET /api/v1/github/installation/repositories',
        'PUT /api/v1/push/subscriptions',
        'GET /api/v1/environment/status',
        'GET /api/v1/accounts/:id/audit',
      ]),
    );
  });

  it.each(registered)('%s declares a scope rule', (route) => {
    expect(
      ROUTE_SCOPES[route as ScopedRoute],
      `add ${route} to ROUTE_SCOPES with its scope rule`,
    ).toBeDefined();
  });

  it('lists no route that is not registered', () => {
    expect(Object.keys(ROUTE_SCOPES).filter((route) => !registered.includes(route))).toEqual([]);
  });

  it('gives every :slug route the project rule', () => {
    const slugRoutes = registered.filter((route) => route.includes('/projects/:slug'));
    expect(slugRoutes.length).toBeGreaterThan(0);
    expect(slugRoutes.filter((route) => ROUTE_SCOPES[route as ScopedRoute] !== 'project')).toEqual([]);
  });

  it('matches the router’s path, HEAD as GET, and nothing it does not list', () => {
    expect(routeScopeOf('GET', '/api/v1/projects/acme/items/TC-1')).toEqual({
      route: 'GET /api/v1/projects/:slug/items/:key',
      rule: 'project',
    });
    expect(routeScopeOf('HEAD', '/api/v1/overview')?.rule).toBe('projects');
    expect(routeScopeOf('GET', '/api/v1/projects/a/b/items')).toBeNull();
    expect(routeScopeOf('DELETE', '/api/v1/overview')).toBeNull();
    expect(routeScopeOf('GET', '/api/v1/nope')).toBeNull();
  });

  // The chokepoint at run time: an unknown path and an unknown method answer the same 404 for every identity.
  it('refuses a path the inventory does not list before any route code, for the owner too', async () => {
    const response = await send('GET', '/api/v1/projects/x/unlisted');
    expect(response.status).toBe(404);
    expect(await slugOf(response)).toBe('not-found');
  });
});

describe('account scope on every route (threat model C9, RR12)', () => {
  let other: SessionUser;

  beforeAll(async () => {
    other = await seedSessionUser('owner');
  });

  // A user of account B against a project of account A must be told exactly what it is told for a slug that does
  // not exist — the same status and the same problem type — so nothing behind a slug is enumerable. The owner of A
  // (the local bypass) is never told `project-not-found` for it.
  describe.each(ofRule('project'))('%s', (route) => {
    it('answers a user of another account as it answers a slug that does not exist', async () => {
      const project = await seedTrackerProject();
      const { method, path } = concrete(route, project.slug);
      const nowhere = concrete(route, 'zz-no-such-project');
      const body = method === 'GET' ? undefined : {};

      const crossAccount = await sendAsSession(other, method, path, body, { github: github() });
      const unknown = await sendAsSession(other, nowhere.method, nowhere.path, body, { github: github() });

      expect(crossAccount.status, 'never a success for another account').toBeGreaterThanOrEqual(400);
      expect([crossAccount.status, await slugOf(crossAccount)]).toEqual([
        unknown.status,
        await slugOf(unknown),
      ]);
      expect([403, 404]).toContain(crossAccount.status);
    });

    it('does not answer project-not-found to the project’s own account', async () => {
      const project = await seedTrackerProject();
      const { method, path } = concrete(route, project.slug);
      // The owner through the local bypass, with the GitHub stub: a GitHub-backed read must never reach the network.
      const response = await fetchApi(path, localEnv(), {
        method,
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
          'Idempotency-Key': newKey(),
        },
        ...(method === 'GET' ? {} : { body: '{}' }),
        github: github(),
      });
      expect(await slugOf(response)).not.toBe('project-not-found');
    });

    it('never succeeds for a job of another project', async () => {
      const project = await seedTrackerProject();
      const { method, path } = concrete(route, project.slug);
      const response = await send(method as 'GET', path, method === 'GET' ? undefined : {}, {
        job: { ...jobActor('pm'), projectSlug: 'zz-other-project' },
      });
      expect([403, 404]).toContain(response.status);
    });
  });

  describe('listings show the scope’s projects only', () => {
    it.each(['GET /api/v1/projects', 'GET /api/v1/needs-you', 'GET /api/v1/overview'] as const)(
      '%s',
      async (route) => {
        const theirs = await seedTrackerProject();
        // A repository name that does not carry the slug, so the check is on names as well as slugs (#482 QA).
        const hiddenRepo = `hidden-org/${crypto.randomUUID().slice(0, 8)}`;
        await env.DB.prepare('UPDATE projects SET repo = ?2 WHERE slug = ?1')
          .bind(theirs.slug, hiddenRepo)
          .run();
        const mine = await seedAccountProject(other.account, { tracker: 'console' });
        const { method, path } = concrete(route, '');

        const response = await sendAsSession(other, method, path, undefined, { github: github() });
        const text = await response.text();

        expect(response.status).toBe(200);
        expect(text).toContain(mine.slug);
        expect(text).not.toContain(theirs.slug);
        expect(text).not.toContain(hiddenRepo);
        expect(text).not.toContain('hidden-org');
      },
    );

    it('GET /api/v1/projects?include=archived', async () => {
      const theirs = await seedTrackerProject();
      const response = await sendAsSession(other, 'GET', '/api/v1/projects?include=archived');
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(theirs.slug);
    });

    // The environment map and the installation list are the environment owner's (ownerOnlyMiddleware, T-4 binds
    // them per user); a session user gets the same 403 as the service identity, with no slug in it.
    it.each(['GET /api/v1/environment/status', 'GET /api/v1/github/installation/repositories'] as const)(
      '%s names no project or repository of another account',
      async (route) => {
        const theirs = await seedTrackerProject();
        const { method, path } = concrete(route, '');
        const response = await sendAsSession(other, method, path, undefined, { github: github() });
        expect(response.status).toBe(403);
        expect(await slugOf(response)).toBe('owner-only');
        const text = await response.text();
        expect(text).not.toContain(theirs.slug);
        expect(text).not.toContain('acme/');
        expect(text).not.toContain('repositories');
      },
    );

    it('a job lists its own project only', async () => {
      const theirs = await seedTrackerProject();
      const own = await seedTrackerProject();
      for (const path of ['/api/v1/projects', '/api/v1/needs-you', '/api/v1/overview']) {
        const response = await send('GET', path, undefined, {
          job: { ...jobActor('pm'), projectSlug: own.slug },
        });
        // Off the matrix, a job is refused before the listing (#444); the listing never names another project.
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(theirs.slug);
      }
    });
  });

  describe('own-user routes', () => {
    it.each(ofRule('own-user'))('%s refuses a session user with 403 owner-only until T-4', async (route) => {
      const { method, path } = concrete(route, '');
      const response = await sendAsSession(other, method, path, method === 'GET' ? undefined : {});
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    });

    it.each(ofRule('own-user'))('%s refuses a job and the service identity', async (route) => {
      const { method, path } = concrete(route, '');
      const job = await send(method as 'GET', path, method === 'GET' ? undefined : {}, {
        job: jobActor('pm'),
      });
      expect(job.status).toBe(403);
      const service = await sendAsService(method, path, method === 'GET' ? undefined : {});
      expect(service.status).toBe(403);
    });
  });

  describe('account routes', () => {
    it.each(ofRule('account'))(
      '%s is unreachable for a job and answers the service identity 404',
      async (route) => {
        const [method = '', pattern = ''] = route.split(' ');
        const path = pattern.replace(':id', other.account.id);
        const job = await send(method as 'GET', path, undefined, { job: jobActor('pm') });
        expect(job.status).toBe(403);
        const service = await sendAsService(method, path);
        expect(service.status).toBe(404);
        expect(await slugOf(service)).toBe('account-not-found');
      },
    );
  });
});
