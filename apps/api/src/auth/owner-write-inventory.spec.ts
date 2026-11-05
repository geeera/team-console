import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createApiApp } from '../app';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { CreateApiAppOptions } from '../app';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';

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
  | 'no-owner-write';

const RULES: Readonly<Record<string, ServiceRule>> = {
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
  // #410 (ADR 0006): the console's own tracker, D1 only. Owner-only in Phase 1a, reads included (their route specs
  // prove the GETs too); the `job` identity and the route matrix arrive with Phase 2 of #309.
  'POST /api/v1/projects/:slug/items': 'owner-only',
  'PATCH /api/v1/projects/:slug/items/:key': 'owner-only',
  'POST /api/v1/projects/:slug/items/:key/comments': 'owner-only',
  'POST /api/v1/projects/:slug/sprints': 'owner-only',
  'PATCH /api/v1/projects/:slug/sprints/:number': 'owner-only',
  'POST /api/v1/projects/:slug/labels': 'owner-only',
  'POST /api/v1/projects': 'no-owner-write',
  'PATCH /api/v1/projects/:slug': 'no-owner-write',
  'POST /api/v1/projects/:slug/archive': 'no-owner-write',
};

const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalised(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

const routes = [
  ...new Set(
    createApiApp()
      .routes.filter((route) => STATE_CHANGING.has(route.method) && route.path.startsWith('/api/'))
      .map((route) => `${route.method} ${normalised(route.path)}`),
  ),
];

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
    const forgedApp = await appWithForgedIdentity({ kind: 'job', role: 'pm' });
    const lines: string[] = [];
    await expectOwnerOnly(await sendAsServiceToken(route, lines, forgedApp));
    // The forged kind really crossed the auth seam and was refused for what it is.
    const log = lines.join('\n');
    expect(log).toContain('"identity":"job"');
    expect(log).toContain('"reason":"job"');
  });
});
