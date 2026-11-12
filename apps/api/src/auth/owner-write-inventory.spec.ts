import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createApiApp } from '../app';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { CreateApiAppOptions } from '../app';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { localEnv } from '../testing/github-kit';
import { localJobHeader } from '../testing/local-job-kit';
import { jobActor, seedTrackerProject, send, sendAsService, slugOf } from '../testing/tracker-kit';
import { JOB_ROLES } from './job-roles';
import { JOB_READ_MODEL_ROUTES, TRACKER_MATRIX } from './tracker-matrix';

// #62: every state-changing /api route says how it treats the dev/stage Access service identity. A new route fails
// "is classified" until someone decides; an owner write must be `owner-only` or carry the fixture gate.
// One read route writes D1: `GET /api/v1/projects/:slug/issues/:number/request` marks a pending owner request
// handled (`owner_requests`, a display cache) and is reachable by the service identity. That is harmless only while a
// row changes on nothing but a trusted bot's strict handled marker — never on GitHub, never on the owner's token;
// owner-request.spec.ts ("the GET changes a row only on a trusted bot's strict marker") pins it (#270).

type ServiceRule =
  /** Refused outright by `ownerOnlyMiddleware` (403 owner-only), before any handler code runs. */
  | 'owner-only'
  /** An owner write allowed only on an `e2e:fixture` issue (`service-write-gate.ts`); proven in its route spec. */
  | 'fixture-gate'
  /** Writes the console's own D1 rows only, never GitHub on the owner's token. */
  | 'no-owner-write'
  /**
   * #434: a job write (an ask, the PM's handled answer). No deployed identity maps to a job before Phase 2, so every
   * real caller is refused — the owner with a role 403, the service with 403 owner-only; proven in the route specs.
   */
  | 'job-only'
  /**
   * #444: a tracker write behind `trackerAccess` — the service is refused there (403 owner-only), the owner and the
   * jobs as their row of `TRACKER_MATRIX` says; every cell is proven in `tracker-matrix.spec.ts`.
   */
  | 'tracker-matrix'
  /**
   * #467: the runner's own door. No identity of this seam reaches it — the one-time code (enrol) or the runner JWT
   * is the credential, judged by `runner-auth.ts` and the route; the service identity, a session and the local
   * owner get 401 `runner-jwt-missing` or, on enrol, the 422 of an empty body. Proven in `runner.spec.ts` and
   * `route-scope.spec.ts`.
   */
  | 'runner-door';

const RULES: Readonly<Record<string, ServiceRule>> = {
  // #467: D1 only, owner-of-account (the service identity is no member: 404 `account-not-found`, account-runners.spec.ts).
  'POST /api/v1/accounts/:id/runners/enrolment-code': 'no-owner-write',
  'PATCH /api/v1/accounts/:id/runners/:runner': 'no-owner-write',
  'POST /api/v1/accounts/:id/runners/:runner/revoke': 'no-owner-write',
  'POST /api/v1/accounts/:id/runners/:runner/clear-suspect': 'no-owner-write',
  'POST /api/v1/accounts/:id/runners/enrolment-codes/:enrolment/withdraw': 'no-owner-write',
  'POST /api/v1/runner/enrol': 'runner-door',
  'POST /api/v1/runner/jobs/claim': 'runner-door',
  'POST /api/v1/runner/jobs/:id/heartbeat': 'runner-door',
  'POST /api/v1/runner/jobs/:id/events': 'runner-door',
  'POST /api/v1/runner/jobs/:id/finish': 'runner-door',
  'PUT /api/v1/accounts/:id/runner-policy': 'no-owner-write',
  // #467: Run now and placement, owner rows of the matrix (the service is refused there like on every tracker write).
  'POST /api/v1/projects/:slug/jobs': 'tracker-matrix',
  'PUT /api/v1/projects/:slug/runner-policy': 'tracker-matrix',
  'POST /api/v1/projects/:slug/issues/:number/answer': 'fixture-gate',
  // #120: writes nothing (it reads the console's own record of an answer); the answer route's gate, shared code.
  'POST /api/v1/projects/:slug/issues/:number/answer/lookup': 'fixture-gate',
  // #220: it answers questions only, which the fixture gate refuses anyway (`service-protected-item: question`).
  'POST /api/v1/projects/:slug/answers/batch': 'owner-only',
  // Not issue-scoped and not needed by e2e on dev/stage: pause/resume write on the run log as the owner, run now
  // starts a team run on the slot's trigger token.
  'POST /api/v1/projects/:slug/team/pause': 'owner-only',
  'POST /api/v1/projects/:slug/team/resume': 'owner-only',
  'POST /api/v1/projects/:slug/runs': 'owner-only',
  // #218: milestone writes on the owner's token; nothing for e2e on dev/stage to do there.
  'POST /api/v1/projects/:slug/sprint/demo-date': 'owner-only',
  'POST /api/v1/projects/:slug/sprint/next': 'owner-only',
  // #219 (ADR 0005 decision 2): a request must be the owner's own wish; the service identity has none to make.
  'POST /api/v1/projects/:slug/issues/:number/request': 'owner-only',
  'POST /api/v1/github/connect': 'owner-only',
  'DELETE /api/v1/github/connection': 'owner-only',
  'PUT /api/v1/push/subscriptions': 'owner-only',
  'DELETE /api/v1/push/subscriptions': 'owner-only',
  'POST /api/v1/push/test': 'owner-only',
  // #221 (architect note on #29, amendment 6): D1 only, but the stage service key must not mute the owner's pushes.
  'PUT /api/v1/projects/:slug/notifications/snooze': 'owner-only',
  'DELETE /api/v1/projects/:slug/notifications/snooze': 'owner-only',
  // #410/#444 (ADR 0006): the console's own tracker, D1 only, behind the route matrix (reads included).
  'POST /api/v1/projects/:slug/items': 'tracker-matrix',
  'PATCH /api/v1/projects/:slug/items/:key': 'tracker-matrix',
  'POST /api/v1/projects/:slug/items/:key/comments': 'tracker-matrix',
  'POST /api/v1/projects/:slug/sprints': 'tracker-matrix',
  'PATCH /api/v1/projects/:slug/sprints/:number': 'tracker-matrix',
  'POST /api/v1/projects/:slug/labels': 'tracker-matrix',
  // #434 (ADR 0006 Phase 1a′): decisions and requests are the owner's own (a job gets 403 owner-only from the
  // matrix); asks and the PM's answer are job writes.
  'POST /api/v1/projects/:slug/items/:key/decisions': 'tracker-matrix',
  'POST /api/v1/projects/:slug/items/:key/requests': 'tracker-matrix',
  'POST /api/v1/projects/:slug/items/:key/events/scrub': 'tracker-matrix',
  'POST /api/v1/projects/:slug/items/:key/asks': 'job-only',
  'POST /api/v1/projects/:slug/requests/:id/handled': 'job-only',
  // #445: `backlog link-pr`, the developers and the orchestrator only (the owner gets 403 pr-link-role).
  'POST /api/v1/projects/:slug/items/:key/pr-links': 'job-only',
  'POST /api/v1/projects': 'no-owner-write',
  'PATCH /api/v1/projects/:slug': 'no-owner-write',
  'POST /api/v1/projects/:slug/archive': 'no-owner-write',
};

const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalised(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

const apiRoutes = [
  ...new Set(
    createApiApp()
      .routes.filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/'))
      .map((route) => `${route.method} ${normalised(route.path)}`),
  ),
];
const routes = apiRoutes.filter((route) => STATE_CHANGING.has(route.split(' ')[0] ?? ''));

afterEach(() => {
  vi.restoreAllMocks();
});

// #434: a fresh copy of the app whose Access claims map to an identity of a kind `authMiddleware` cannot mint today
// (the Phase 2 `job` identity, or any later one), so the request still crosses the real auth seam.
async function appWithForgedIdentity(identity: unknown): Promise<typeof createApiApp> {
  vi.resetModules();
  vi.doMock('./access-jwt', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./access-jwt')>()),
    identityOf: () => ({ ok: true, identity }),
  }));
  try {
    const fresh: typeof import('../app') = await import('../app');
    return fresh.createApiApp;
  } finally {
    vi.doUnmock('./access-jwt');
  }
}

describe('owner-write inventory (#62)', () => {
  it('finds the state-changing routes (the inventory is not vacuous)', () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        'POST /api/v1/projects/:slug/issues/:number/answer',
        'POST /api/v1/projects/:slug/team/pause',
      ]),
    );
  });

  it.each(routes)('%s is classified', (route) => {
    expect(RULES[route], `decide how ${route} treats the service identity`).toBeDefined();
  });

  it('lists no route that no longer exists', () => {
    expect(Object.keys(RULES).filter((route) => !routes.includes(route))).toEqual([]);
  });

  const ownerOnly = Object.entries(RULES)
    .filter(([, rule]) => rule === 'owner-only')
    .map(([route]) => route);

  async function sendAsServiceToken(
    route: string,
    lines: string[] = [],
    app: (options: CreateApiAppOptions) => ReturnType<typeof createApiApp> = createApiApp,
  ): Promise<Response> {
    const [method = '', pattern = ''] = route.split(' ');
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
    });
    const ctx = createExecutionContext();
    const request = new Request(`http://api.test${pattern.replace(/:[^/]+/g, 'x')}`, {
      method,
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const response = await app({ logSink: (line) => lines.push(line) }).fetch(
      request,
      accessEnv(teamDomain),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function expectOwnerOnly(response: Response): Promise<void> {
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(isProblemDetails(body) ? problemSlugOf(body.type) : body).toBe('owner-only');
  }

  it.each(ownerOnly)('%s answers 403 owner-only to the service identity', async (route) => {
    await expectOwnerOnly(await sendAsServiceToken(route));
  });

  it.each(ownerOnly)('%s answers 403 owner-only to an identity of an unknown kind', async (route) => {
    const forgedApp = await appWithForgedIdentity({ kind: 'runner', runnerId: 'r1' });
    const lines: string[] = [];
    await expectOwnerOnly(await sendAsServiceToken(route, lines, forgedApp));
    // The forged kind really crossed the auth seam and was refused for what it is.
    const log = lines.join('\n');
    expect(log).toContain('"identity":"runner"');
    expect(log).toContain('"reason":"runner"');
  });

  // #443: the fixture-gate routes skip ownerOnlyMiddleware for the service identity only; any other kind is refused
  // before the project is even looked up.
  const fixtureGated = Object.entries(RULES)
    .filter(([, rule]) => rule === 'fixture-gate')
    .map(([route]) => route);

  it.each(fixtureGated)('%s answers 403 owner-only to an identity of an unknown kind', async (route) => {
    const forgedApp = await appWithForgedIdentity({ kind: 'runner', runnerId: 'r1' });
    const lines: string[] = [];
    await expectOwnerOnly(await sendAsServiceToken(route, lines, forgedApp));
    expect(lines.join('\n')).toContain('"reason":"runner"');
  });

  const trackerWrites = Object.entries(RULES)
    .filter(([, rule]) => rule === 'tracker-matrix' || rule === 'job-only')
    .map(([route]) => route);

  it('finds the tracker writes, each a row of the route matrix', () => {
    expect(trackerWrites.length).toBeGreaterThan(0);
    expect(trackerWrites.filter((route) => !(route in TRACKER_MATRIX))).toEqual([]);
  });

  it.each(trackerWrites)('%s answers 403 owner-only to the service identity', async (route) => {
    await expectOwnerOnly(await sendAsServiceToken(route));
  });

  const jobOnly = Object.entries(RULES)
    .filter(([, rule]) => rule === 'job-only')
    .map(([route]) => route);

  it('finds the job-only routes', () => {
    expect(jobOnly.length).toBeGreaterThan(0);
  });

  it.each(jobOnly)(
    '%s refuses the owner (a role 403) and the service identity (403 owner-only)',
    async (route) => {
      const [method = '', pattern = ''] = route.split(' ');
      const { slug } = await seedTrackerProject();
      const path = pattern.replace(':slug', slug).replace(/:[^/]+/g, '1');
      const owner = await send(method as 'POST', path, {});
      expect(owner.status).toBe(403);
      expect(['ask-role', 'request-handled-role', 'pr-link-role']).toContain(await slugOf(owner));
      const service = await sendAsService(method, path, {});
      expect(service.status).toBe(403);
      expect(await slugOf(service)).toBe('owner-only');
    },
  );

  // #444, the job column. A job identity on a deployed config (here forged past the Access check, since nothing there
  // can mint one) maps to no policy actor: the tracker refuses it like the service, every other route never lets
  // it in.
  const forgedJob = {
    kind: 'job',
    role: 'pm',
    projectSlug: 'x',
    jobId: 'job-forged',
    items: [1],
  };
  const seamRoutes = routes.filter((route) => RULES[route] !== 'runner-door');
  const runnerDoor = routes.filter((route) => RULES[route] === 'runner-door');

  it.each(seamRoutes)('%s answers 403 owner-only to a job identity on a deployed config', async (route) => {
    const forgedApp = await appWithForgedIdentity(forgedJob);
    await expectOwnerOnly(await sendAsServiceToken(route, [], forgedApp));
  });

  // #467: the runner's door never reads the Access seam, so a forged Access identity is not even minted there; an
  // empty enrol body is refused as input, never admitted as anyone.
  it.each(runnerDoor)('%s never admits a forged identity of the Access seam', async (route) => {
    const forgedApp = await appWithForgedIdentity(forgedJob);
    const response = await sendAsServiceToken(route, [], forgedApp);
    if (route === 'POST /api/v1/runner/enrol') {
      expect(response.status).toBe(422);
      expect(await slugOf(response)).toBe('enrol-invalid');
    } else {
      expect(response.status).toBe(401);
      expect(await slugOf(response)).toBe('runner-jwt-missing');
    }
  });
});

// #444: the local job stand-in reaches the tracker's matrix routes and nothing else — not the GitHub-backed reads,
// the registry, the answer or connection routes, whatever its role. #445: besides its project's inbox, questions and
// sprint (`JOB_READ_MODEL_ROUTES`; project-read-models.spec.ts proves them, another project's 404 included).
describe('the job column off the tracker (#444)', () => {
  const isRunnerDoor = (route: string): boolean => route.includes(' /api/v1/runner/');
  const readModels: readonly string[] = JOB_READ_MODEL_ROUTES;
  const offTracker = apiRoutes.filter(
    (route) => !(route in TRACKER_MATRIX) && !readModels.includes(route) && !isRunnerDoor(route),
  );
  const runnerDoor = apiRoutes.filter(isRunnerDoor);

  it('finds routes off the tracker (the check is not vacuous)', () => {
    expect(offTracker).toEqual(
      expect.arrayContaining(['GET /api/v1/projects', 'POST /api/v1/projects/:slug/issues/:number/answer']),
    );
    expect(runnerDoor).toEqual(
      expect.arrayContaining(['POST /api/v1/runner/enrol', 'GET /api/v1/runner/release']),
    );
    expect(apiRoutes).toEqual(expect.arrayContaining([...JOB_READ_MODEL_ROUTES]));
  });

  // #467: on the runner's door the stand-in is a bearer that is no runner JWT (401), or an empty enrol body (422).
  it.each(runnerDoor)('%s never admits the local job stand-in as a runner', async (route) => {
    const [method = '', pattern = ''] = route.split(' ');
    for (const [index, role] of JOB_ROLES.entries()) {
      const response = await send(method as 'POST', pattern, method === 'GET' ? undefined : {}, {
        job: jobActor(role),
        // One address per role: the enrol limit per address judges one case, not the fourteen.
        headers: { 'CF-Connecting-IP': `10.44.7.${String(index + 1)}` },
      });
      expect([401, 422], `${role} on ${route}`).toContain(response.status);
    }
  });

  it.each(offTracker)('%s answers 403 owner-only to the local job stand-in of every role', async (route) => {
    const [method = '', pattern = ''] = route.split(' ');
    const { slug } = await seedTrackerProject();
    const path = pattern
      .replace(':slug', slug)
      .replace(/:[^/]+/g, '1')
      .replace(/\*/g, 'x');
    for (const role of JOB_ROLES) {
      const response = await send(method as 'POST', path, method === 'GET' ? undefined : {}, {
        job: jobActor(role),
      });
      expect(response.status, `${role} on ${route}`).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    }
  });

  it('answers 403 to the stand-in on every method of a tracker path the matrix does not list', async () => {
    const { slug } = await seedTrackerProject();
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await fetchAsJob(method, `/api/v1/projects/${slug}/items/1`);
      expect(response.status).toBe(403);
    }
  });
});

async function fetchAsJob(method: string, path: string): Promise<Response> {
  return fetchApi(path, localEnv(), {
    method,
    headers: { Authorization: localJobHeader(jobActor('pm'), path), 'Content-Type': 'application/json' },
    body: '{}',
  });
}
