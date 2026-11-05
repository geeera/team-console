import { env } from 'cloudflare:test';
import { isEnvironmentStatusDto, type EnvironmentStatusDto } from '@shared/environment';
import { problemSlugOf, isProblemDetails } from '@shared/contracts';
import {
  OWNER,
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { localEnv, resetProjects, seedProject } from '../testing/github-kit';
import type { ApiEnv } from '../env';

// #104: presence only. Every binding below holds a sentinel, built at run time so no scanner sees a credential-shaped
// literal; neither it, nor a prefix, nor its length may show in a body or a log line.
const SENTINEL = ['SENTINEL', 'environment', crypto.randomUUID().replace(/-/g, '')].join('_');
const PATH = '/api/v1/environment/status';

function sentinelBindings(): Record<string, string> {
  return {
    // OWNER_EMAIL stays the signed owner's address (Access compares it), and is checked for below.
    GITHUB_APP_PRIVATE_KEY: SENTINEL,
    GITHUB_APP_CLIENT_SECRET: SENTINEL,
    TOKEN_ENCRYPTION_KEY: SENTINEL,
    VAPID_PRIVATE_KEY: SENTINEL,
    VAPID_PUBLIC_KEY: SENTINEL,
    // Not ACCESS_AUD: emptying it would turn Access off for the request itself.
    GITHUB_APP_CLIENT_ID: '',
    ROUTINE_TOKEN_STORIFY: SENTINEL,
    SLOT_TOKEN_STORIFY_PM: '   ',
    // The hooks Worker's secret on the api Worker would still not be read: the hooks group is never checked here.
    WEBHOOK_SECRET: SENTINEL,
    GITHUB_FAKE_ORIGIN: SENTINEL,
  };
}

async function signedProductionOwner(
  overrides: Record<string, string>,
  claims: Record<string, unknown> = {},
): Promise<{ bindings: ApiEnv; token: string }> {
  const jwks = stubJwksServer();
  const teamDomain = uniqueTeamDomain();
  const key = await createSigningKey();
  jwks.set(teamDomain, { keys: [key.publicJwk] });
  return {
    bindings: accessEnv(teamDomain, {
      ...overrides,
      ENVIRONMENT: 'production',
      ALLOW_SERVICE_TOKEN: 'false',
    }),
    token: await signAccessToken(key, teamDomain, { claims }),
  };
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(SENTINEL.slice(0, 12));
  expect(text).not.toContain(SENTINEL.slice(-8));
  // A bare `\b${SENTINEL.length}\b` match is too broad: it also fires on unrelated digits that happen to share
  // the sentinel's length, e.g. a timestamp's seconds field. Only flag the length where it is named as one —
  // next to a 'length' key, or worded as "N chars/characters/bytes" — the shapes a masking bug that logs
  // `value.length` instead of the masked value would actually produce.
  expect(text).not.toMatch(new RegExp(`length["'\\s:=]{1,6}${SENTINEL.length}\\b`, 'i'));
  expect(text).not.toMatch(new RegExp(`\\b${SENTINEL.length}\\s*(chars?|characters|bytes)\\b`, 'i'));
}

beforeEach(async () => {
  await resetProjects();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/environment/status (#104)', () => {
  it('reports the local console’s own --vars, set or missing', async () => {
    const response = await fetchApi(PATH, localEnv({ GITHUB_MOCK: 'true', ROUTINES_FAKE_ORIGIN: '' }));

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isEnvironmentStatusDto(body)).toBe(true);
    const status = body as EnvironmentStatusDto;
    expect(status.environment).toBe('local');
    const byId = new Map(status.items.map((item) => [item.id, item.status]));
    expect(byId.get('local/AUTH_MODE')).toBe('set');
    expect(byId.get('local/GITHUB_MOCK')).toBe('set');
    expect(byId.get('local/ROUTINES_FAKE_ORIGIN')).toBe('missing');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('reports production’s Worker secrets, GitHub variables and per-project tokens, never a value', async () => {
    await seedProject('storify', 'geeera/storify');
    const logs: string[] = [];
    const { bindings, token } = await signedProductionOwner(sentinelBindings());

    const response = await fetchApi(PATH, bindings, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
      logSink: (line) => logs.push(line),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    const status = JSON.parse(text) as EnvironmentStatusDto;
    const byId = new Map(status.items.map((item) => [item.id, item.status]));
    expect(status.environment).toBe('production');
    expect(byId.get('api/OWNER_EMAIL')).toBe('set');
    expect(byId.get('github-vars/ACCESS_AUD')).toBe('set');
    expect(byId.get('github-vars/CONSOLE_GITHUB_APP_CLIENT_ID')).toBe('missing');
    expect(byId.get('github-vars/VAPID_PUBLIC_KEY')).toBe('set');
    expect(byId.get('project/storify/ROUTINE_TOKEN_STORIFY')).toBe('set');
    expect(byId.get('project/storify/SLOT_TOKEN_STORIFY_PM')).toBe('missing');
    // What this Worker cannot see is left out, not guessed.
    expect(byId.has('hooks/WEBHOOK_SECRET')).toBe(false);
    expect(byId.has('github-secrets/CLOUDFLARE_API_TOKEN')).toBe(false);
    expect(byId.has('local/GITHUB_FAKE_ORIGIN')).toBe(false);
    for (const item of status.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'optional', 'status']);
    }

    expectNoLeak(text);
    expect(text).not.toContain(OWNER);
    expectNoLeak([...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n'));
    expect(logs.length).toBeGreaterThan(0);
    expectNoLeak(logs.join('\n'));
  });

  it('lists only registered, non-archived projects', async () => {
    await seedProject('storify', 'geeera/storify');
    await seedProject('old', 'geeera/old');
    await env.DB.prepare("UPDATE projects SET archived_at = '2026-10-01T00:00:00Z' WHERE slug = 'old'").run();
    const { bindings, token } = await signedProductionOwner(sentinelBindings());

    const response = await fetchApi(PATH, bindings, { headers: { 'Cf-Access-Jwt-Assertion': token } });

    const status = (await response.json()) as EnvironmentStatusDto;
    const projects = new Set(
      status.items.filter((item) => item.id.startsWith('project/')).map((item) => item.id.split('/')[1]),
    );
    expect([...projects]).toEqual(['storify']);
  });

  it('refuses the service identity with 403 owner-only and reads nothing', async () => {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
    });
    const logs: string[] = [];

    const response = await fetchApi(PATH, accessEnv(teamDomain, sentinelBindings()), {
      headers: { 'Cf-Access-Jwt-Assertion': token },
      logSink: (line) => logs.push(line),
    });

    expect(response.status).toBe(403);
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    expect(isProblemDetails(body) && problemSlugOf(body.type)).toBe('owner-only');
    expectNoLeak(text);
    expectNoLeak(logs.join('\n'));
  });

  it('never reports for an unknown ENVIRONMENT: the auth seam fails closed before the route', async () => {
    const { bindings, token } = await signedProductionOwner(sentinelBindings());

    const response = await fetchApi(PATH, { ...bindings, ENVIRONMENT: 'qa' } as ApiEnv, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });

    expect(response.status).toBe(401);
    expectNoLeak(await response.text());
  });
});
