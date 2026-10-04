import { SELF, env } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails } from '@shared/contracts';

const ORIGIN = 'http://hooks.test';

describe('GET /healthz', () => {
  it('answers 200 with liveness only — no environment, no version (public Worker)', async () => {
    const response = await SELF.fetch(`${ORIGIN}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('unknown routes', () => {
  it.each(['/', '/hooks', '/hooks/gitlab', '/api/v1/healthz'])(
    '%s answers a problem+json 404',
    async (path) => {
      const response = await SELF.fetch(`${ORIGIN}${path}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
      const body: unknown = await response.json();
      expect(isProblemDetails(body)).toBe(true);
      expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}not-found`, status: 404 });
    },
  );
});

describe('bindings', () => {
  it('shares the migrated database with the api Worker', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    ).all<{ name: string }>();
    expect(results).toEqual([{ name: 'projects' }]);
  });

  // Matched by prefix so this file itself names no credential (tools/workspace-checks scans apps/hooks).
  it('holds no GitHub credential and no token encryption key', () => {
    const bindings = Object.keys(env).filter((key) => key.startsWith('GITHUB') || key.includes('ENCRYPTION'));
    expect(bindings).toEqual([]);
  });
});
