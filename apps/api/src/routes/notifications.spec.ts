import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf, type ProjectDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { localEnv, resetProjects, seedProject, stubGitHub } from '../testing/github-kit';
import { parseSnooze } from './notifications';

// #221: snooze a project's notifications. D1 only — every case also proves GitHub was never called.

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
const PATH = '/api/v1/projects/tc/notifications/snooze';

interface Harness {
  readonly github: ApiGitHub;
  readonly githubCalls: () => number;
  clock: number;
}

function harness(): Harness {
  const stub = stubGitHub(async () => {
    throw new Error('snooze must not call GitHub');
  });
  const h = { clock: NOW } as Harness;
  Object.assign(h, {
    github: new ApiGitHub({ fetch: stub.fetch, now: () => h.clock, sleep: async () => undefined }),
    githubCalls: () => stub.calls.length,
  });
  return h;
}

async function send(
  h: Harness,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetchApi(path, localEnv(), {
    method,
    headers: method === 'GET' ? {} : WRITE_HEADERS,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    github: h.github,
  });
}

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

async function listed(h: Harness): Promise<ProjectDto | undefined> {
  const projects = (await (await send(h, 'GET', '/api/v1/projects')).json()) as ProjectDto[];
  return projects.find((project) => project.slug === 'tc');
}

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', 'geeera/team-console');
});

describe('PUT /projects/:slug/notifications/snooze', () => {
  it('snoozes for an hour and answers the snooze; the projects list carries it for the sidebar', async () => {
    const h = harness();
    const until = new Date(NOW + HOUR).toISOString();
    const response = await send(h, 'PUT', PATH, { until, allowsUrgent: true });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      snoozed: true,
      until,
      allowsUrgent: true,
      since: new Date(NOW).toISOString(),
    });
    expect((await listed(h))?.snooze).toEqual({
      snoozed: true,
      until,
      allowsUrgent: true,
      since: new Date(NOW).toISOString(),
    });
    expect(h.githubCalls()).toBe(0);
  });

  it('snoozes until turned back on, with urgent ones muted too, normalising nothing it does not need', async () => {
    const h = harness();
    const response = await send(h, 'PUT', PATH, { until: null, allowsUrgent: false });
    expect(await response.json()).toEqual({
      snoozed: true,
      until: null,
      allowsUrgent: false,
      since: new Date(NOW).toISOString(),
    });
  });

  it('stores an offset time as UTC (the device sends "until 9:00" in its own zone)', async () => {
    const h = harness();
    const response = await send(h, 'PUT', PATH, { until: '2026-10-06T09:00:00+03:00', allowsUrgent: true });
    expect(await response.json()).toMatchObject({ until: '2026-10-06T06:00:00.000Z' });
  });

  it('a later snooze replaces the earlier one', async () => {
    const h = harness();
    await send(h, 'PUT', PATH, { until: null, allowsUrgent: false });
    h.clock += 5 * 60 * 1000;
    const until = new Date(h.clock + 7 * DAY).toISOString();
    await send(h, 'PUT', PATH, { until, allowsUrgent: true });
    expect((await listed(h))?.snooze).toEqual({
      snoozed: true,
      until,
      allowsUrgent: true,
      since: new Date(h.clock).toISOString(),
    });
  });

  it('an expired snooze reads as not snoozed with no cleanup', async () => {
    const h = harness();
    await send(h, 'PUT', PATH, { until: new Date(NOW + HOUR).toISOString(), allowsUrgent: true });
    h.clock = NOW + HOUR;
    expect((await listed(h))?.snooze).toEqual({ snoozed: false });
    const row = await env.DB.prepare('SELECT snoozed_at FROM projects WHERE slug = ?1')
      .bind('tc')
      .first<{ snoozed_at: string | null }>();
    expect(row?.snoozed_at).toBe(new Date(NOW).toISOString());
  });

  it('answers 404 for an unknown or archived project, writing nothing', async () => {
    const h = harness();
    const body = { until: null, allowsUrgent: true };
    const unknown = await send(h, 'PUT', '/api/v1/projects/nope/notifications/snooze', body);
    expect(unknown.status).toBe(404);
    expect(await slugOf(unknown)).toBe('project-not-found');

    await env.DB.prepare("UPDATE projects SET archived_at = '2026-10-01T00:00:00Z' WHERE slug = 'tc'").run();
    expect((await send(h, 'PUT', PATH, body)).status).toBe(404);
  });

  it('refuses a body that is not JSON with 422 and writes nothing', async () => {
    const h = harness();
    const response = await send(h, 'PUT', PATH, '{not json');
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('validation');
    expect((await listed(h))?.snooze).toEqual({ snoozed: false });
  });
});

describe('parseSnooze — the validation table', () => {
  const at = (ms: number): string => new Date(NOW + ms).toISOString();

  it.each([
    ['an hour', { until: at(HOUR), allowsUrgent: true }, { until: at(HOUR), allowsUrgent: true }],
    [
      '31 days exactly',
      { until: at(31 * DAY), allowsUrgent: false },
      { until: at(31 * DAY), allowsUrgent: false },
    ],
    ['until turned back on', { until: null, allowsUrgent: true }, { until: null, allowsUrgent: true }],
    [
      'an offset time',
      { until: '2026-10-06T09:00+03:00', allowsUrgent: true },
      { until: '2026-10-06T06:00:00.000Z', allowsUrgent: true },
    ],
  ])('accepts %s', (_name, body, expected) => {
    expect(parseSnooze(body, NOW)).toEqual(expected);
  });

  it.each([
    ['no body', undefined, 'The body must be'],
    ['an array', [], 'The body must be'],
    ['an extra key', { until: null, allowsUrgent: true, devices: 'all' }, 'The body must be'],
    ['no allowsUrgent', { until: null }, 'allowsUrgent must be a boolean'],
    ['allowsUrgent as text', { until: null, allowsUrgent: 'true' }, 'allowsUrgent must be a boolean'],
    ['no until', { allowsUrgent: true }, 'until must be an ISO 8601'],
    ['until as a number', { until: NOW + HOUR, allowsUrgent: true }, 'until must be an ISO 8601'],
    ['a bare date', { until: '2026-10-06', allowsUrgent: true }, 'until must be an ISO 8601'],
    [
      'a time without a zone',
      { until: '2026-10-06T09:00:00', allowsUrgent: true },
      'until must be an ISO 8601',
    ],
    [
      'an impossible date',
      { until: '2026-13-45T09:00:00Z', allowsUrgent: true },
      'until must be an ISO 8601',
    ],
    ['now', { until: at(0), allowsUrgent: true }, 'until must be in the future'],
    ['the past', { until: at(-HOUR), allowsUrgent: true }, 'until must be in the future'],
    ['past 31 days', { until: at(31 * DAY + 1000), allowsUrgent: true }, 'at most 31 days away'],
  ])('refuses %s', (_name, body, detail) => {
    const result = parseSnooze(body, NOW);
    expect(typeof result).toBe('string');
    expect(result).toContain(detail);
  });
});

describe('DELETE /projects/:slug/notifications/snooze', () => {
  it('turns notifications back on in one call, and again without harm', async () => {
    const h = harness();
    await send(h, 'PUT', PATH, { until: null, allowsUrgent: false });

    const response = await send(h, 'DELETE', PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snoozed: false });
    expect((await listed(h))?.snooze).toEqual({ snoozed: false });
    expect((await send(h, 'DELETE', PATH)).status).toBe(200);
    expect(h.githubCalls()).toBe(0);
  });

  it('answers 404 for an unknown project', async () => {
    const h = harness();
    const response = await send(h, 'DELETE', '/api/v1/projects/nope/notifications/snooze');
    expect(response.status).toBe(404);
  });
});

describe('the Access service identity (owner-only)', () => {
  it.each(['PUT', 'DELETE'] as const)(
    '%s answers 403 owner-only and leaves the snooze alone',
    async (method) => {
      const h = harness();
      await send(h, 'PUT', PATH, { until: null, allowsUrgent: true });

      const jwks = stubJwksServer();
      const teamDomain = uniqueTeamDomain();
      const key = await createSigningKey();
      jwks.set(teamDomain, { keys: [key.publicJwk] });
      const token = await signAccessToken(key, teamDomain, {
        claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
      });
      const response = await fetchApi(PATH, accessEnv(teamDomain), {
        method,
        headers: { ...WRITE_HEADERS, 'Cf-Access-Jwt-Assertion': token },
        body: JSON.stringify({ until: null, allowsUrgent: false }),
        github: h.github,
      });
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
      expect((await listed(h))?.snooze).toMatchObject({ snoozed: true, allowsUrgent: true });
      expect(h.githubCalls()).toBe(0);
    },
  );
});
