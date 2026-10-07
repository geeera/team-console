import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createApiApp } from '../app';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';

// #62: every state-changing /api route says how it treats the dev/stage Access service identity. A new route fails
// "is classified" until someone decides; an owner write must be `owner-only` or carry the fixture gate.

type ServiceRule =
  /** Refused outright by `ownerOnlyMiddleware` (403 owner-only), before any handler code runs. */
  | 'owner-only'
  /** An owner write allowed only on an `e2e:fixture` issue (`service-write-gate.ts`); proven in its route spec. */
  | 'fixture-gate'
  /** Writes the console's own D1 rows only, never GitHub on the owner's token. */
  | 'no-owner-write';

const RULES: Readonly<Record<string, ServiceRule>> = {
  'POST /api/v1/projects/:slug/issues/:number/answer': 'fixture-gate',
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

  it.each(ownerOnly)('%s answers 403 owner-only to the service identity', async (route) => {
    const [method = '', pattern = ''] = route.split(' ');
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
    });
    const response = await fetchApi(pattern.replace(/:[^/]+/g, 'x'), accessEnv(teamDomain), {
      method,
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(isProblemDetails(body) ? problemSlugOf(body.type) : body).toBe('owner-only');
  });
});
