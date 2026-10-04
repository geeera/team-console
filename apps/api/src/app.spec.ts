import { SELF, env } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails } from '@shared/contracts';
import { version } from '../../../package.json';

const ORIGIN = 'http://api.test';

async function problemOf(response: Response) {
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem body: ${JSON.stringify(body)}`);
  }
  return body;
}

describe('GET /api/v1/healthz', () => {
  it('answers 200 JSON with status, environment and version', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok', environment: 'local', version });
  });

  it('carries a request id the client can quote', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/healthz`, {
      headers: { 'X-Request-Id': 'from-client-1' },
    });
    expect(response.headers.get('x-request-id')).toBe('from-client-1');
  });
});

describe('unknown /api/v1 routes', () => {
  it('answer RFC 9457 problem+json, not HTML and not the SPA', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/nope`);

    expect(response.status).toBe(404);
    const body = await problemOf(response);
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}not-found`, title: 'Not Found', status: 404 });
    expect(body.instance).toBe(response.headers.get('x-request-id'));
  });

  it('answer the same for a wrong method on a known path', async () => {
    // Same-origin, so the CSRF check lets it reach routing.
    const response = await SELF.fetch(`${ORIGIN}/api/v1/healthz`, {
      method: 'DELETE',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(response.status).toBe(404);
    await problemOf(response);
  });

  it('answer the same outside v1', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v2/healthz`);
    expect(response.status).toBe(404);
    await problemOf(response);
  });
});

describe('bare /api paths (#51)', () => {
  // The pool sends every request to the Worker first, so this proves the Worker's side (problem, not the shell);
  // that the edge routes them here is `run_worker_first` in wrangler.jsonc, asserted in tools/workspace-checks.
  it.each(['/api', '/api/'])(
    '%s reaches the Worker and answers problem+json, not the app shell',
    async (path) => {
      const response = await SELF.fetch(`${ORIGIN}${path}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('x-request-id')).not.toBeNull();
      await problemOf(response);
    },
  );
});

describe('the app shell', () => {
  it('is served from the assets binding at /', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('test shell');
  });

  it('falls back to index.html for a client-side route (single-page-application)', async () => {
    const response = await SELF.fetch(`${ORIGIN}/p/team-console/board`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('GET /api/v1/projects', () => {
  it('returns [] on a fresh database, proving the D1 binding', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/projects`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('lists registered projects as DTOs', async () => {
    await env.DB.prepare('INSERT INTO projects (slug, repo, display_name, added_at) VALUES (?1, ?2, ?3, ?4)')
      .bind('tc', 'geeera/team-console', 'Team Console', '2026-09-29T00:00:00Z')
      .run();

    const response = await SELF.fetch(`${ORIGIN}/api/v1/projects`);

    await expect(response.json()).resolves.toEqual([
      {
        slug: 'tc',
        repo: 'geeera/team-console',
        displayName: 'Team Console',
        routineId: null,
        addedAt: '2026-09-29T00:00:00Z',
        archivedAt: null,
        slots: { pm: 'missing', dev: 'missing', qa: 'missing' },
        // No GitHub app credentials in this pool: project.yml cannot be read, so nothing is embeddable.
        embedOrigins: [],
      },
    ]);
  });
});
