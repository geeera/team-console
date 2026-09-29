import { Hono } from 'hono';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails } from '@shared/contracts';
import { createWorkerApp, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';
import {
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { csrfMiddleware } from './csrf.middleware';

// Threat model #8, row 5. No write route exists yet (#10 adds the first), so the rules are proven on a probe app
// with the same middleware, and the real app is checked for its seam and its lack of CORS headers.

const ORIGIN = 'https://team-console-dev.example.workers.dev';

function probeApp(): Hono<WorkerHonoEnv<ApiEnv>> {
  const app = createWorkerApp<ApiEnv>({ service: 'csrf-probe' });
  app.use('/api/*', csrfMiddleware);
  app.all('/api/v1/probe', (c) => c.json({ reached: true }));
  return app;
}

async function send(
  method: string,
  headers: Record<string, string>,
  body?: string | ReadableStream<Uint8Array>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = body;
  }
  const response = await probeApp().fetch(new Request(`${ORIGIN}/api/v1/probe`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function expectProblem(response: Response, slug: string, status: number): Promise<void> {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  expect(isProblemDetails(body)).toBe(true);
  expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}${slug}`, status });
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

describe('csrfMiddleware', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('lets a safe %s through from anywhere', async (method) => {
    const response = await send(method, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' });
    expect(response.status).toBe(200);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('lets a same-origin JSON %s through', async (method) => {
    const response = await send(
      method,
      { 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN, ...JSON_TYPE },
      '{}',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: true });
  });

  it('accepts a JSON content type with parameters', async () => {
    const response = await send(
      'POST',
      { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'Application/JSON; charset=utf-8' },
      '{}',
    );
    expect(response.status).toBe(200);
  });

  it('accepts a same-origin POST without a body and without a content type', async () => {
    expect((await send('POST', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });

  it('rejects Origin: https://evil.example with 403 csrf', async () => {
    await expectProblem(
      await send('POST', { Origin: 'https://evil.example', ...JSON_TYPE }, '{}'),
      'csrf',
      403,
    );
  });

  it.each(['cross-site', 'same-site', 'none'])('rejects Sec-Fetch-Site: %s with 403 csrf', async (site) => {
    await expectProblem(
      await send('POST', { 'Sec-Fetch-Site': site, Origin: ORIGIN, ...JSON_TYPE }, '{}'),
      'csrf',
      403,
    );
  });

  it('judges by Sec-Fetch-Site when present, even if Origin looks right', async () => {
    await expectProblem(
      await send('DELETE', { 'Sec-Fetch-Site': 'cross-site', Origin: ORIGIN }),
      'csrf',
      403,
    );
  });

  it('falls back to Origin equal to our own when Sec-Fetch-Site is absent', async () => {
    expect((await send('POST', { Origin: ORIGIN, ...JSON_TYPE }, '{}')).status).toBe(200);
  });

  it('rejects a write with neither Sec-Fetch-Site nor Origin', async () => {
    await expectProblem(await send('POST', JSON_TYPE, '{}'), 'csrf', 403);
  });

  it('rejects an Origin of "null" (sandboxed frames, data: URLs)', async () => {
    await expectProblem(await send('POST', { Origin: 'null', ...JSON_TYPE }, '{}'), 'csrf', 403);
  });

  it('rejects a text/plain body with 415', async () => {
    await expectProblem(
      await send('POST', { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' }, '{}'),
      'unsupported-media-type',
      415,
    );
  });

  it.each(['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'rejects a form body (%s) with 415',
    async (contentType) => {
      await expectProblem(
        await send('POST', { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': contentType }, 'a=1'),
        'unsupported-media-type',
        415,
      );
    },
  );

  it('rejects a body without a content type with 415', async () => {
    // A stream body, unlike a string, gets no implicit text/plain from the Request constructor.
    const body = new Blob(['{}']).stream();
    const response = await send('POST', { 'Sec-Fetch-Site': 'same-origin' }, body);
    await expectProblem(response, 'unsupported-media-type', 415);
  });
});

describe('the api app', () => {
  it('runs the CSRF check behind a verified token on /api/*', async () => {
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    const jwks = stubJwksServer();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain);

    const response = await fetchApi('/api/v1/projects', accessEnv(teamDomain), {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Sec-Fetch-Site': 'cross-site',
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    await expectProblem(response, 'csrf', 403);
    vi.restoreAllMocks();
  });

  it.each([
    ['a preflight', 'OPTIONS', { 'Access-Control-Request-Method': 'POST' }],
    ['a GET', 'GET', {}],
    ['a POST', 'POST', { 'Content-Type': 'application/json' }],
  ])('sends no CORS headers for %s from another origin', async (_name, method, extra) => {
    const local = accessEnv(uniqueTeamDomain(), { ENVIRONMENT: 'local', AUTH_MODE: 'local' });
    const response = await fetchApi('/api/v1/healthz', local, {
      method,
      headers: { Origin: 'https://evil.example', ...extra },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
