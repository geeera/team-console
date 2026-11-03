import { HTTPException } from 'hono/http-exception';
import { PROBLEM_TYPE_PREFIX, isProblemDetails } from '@shared/contracts';
import { createWorkerApp, markAssetResponse } from './app';
import type { WorkerBaseEnv } from './env';
import { problem } from './problem';

const JWT_SENTINEL = 'eyJhbGciOiJSUzI1NiJ9.sentinel.signature';

// The core never touches the database; a stub keeps the binding shape without a runtime.
const env: WorkerBaseEnv = { ENVIRONMENT: 'local', DB: {} as unknown as D1Database };

function build(logSink?: (line: string) => void) {
  const app = createWorkerApp<WorkerBaseEnv>({
    service: 'test',
    ...(logSink === undefined ? {} : { logSink }),
  });
  app.get('/ok', (c) => c.json({ ok: true }));
  app.get('/boom', () => {
    throw new Error(`boom ${JWT_SENTINEL}`);
  });
  app.get('/too-big', () => {
    throw new HTTPException(413, { message: 'Body too large' });
  });
  app.get('/teapot', () => {
    throw new HTTPException(418, { message: 'Short and stout' });
  });
  app.get('/rate-limited', (c) =>
    problem(c, { type: 'github-rate-limit', title: 'GitHub rate limit', status: 429, retryAfter: 30 }),
  );
  app.get('/with-step', (c) =>
    problem(c, {
      type: 'project-yml-missing',
      title: 'No project.yml',
      status: 422,
      extensions: { step: 'project-yml', retryable: false, section: null, allowed: ['go', 'no-go'] },
    }),
  );
  app.get('/replaces-type', (c) =>
    problem(c, { type: 'x', title: 'X', status: 400, extensions: { type: 'about:blank' } }),
  );
  return app;
}

async function problemOf(response: Response) {
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem body: ${JSON.stringify(body)}`);
  }
  return body;
}

describe('createWorkerApp', () => {
  it('serves the routes the caller adds', async () => {
    const response = await build().request('/ok', {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('answers unknown paths with a 404 problem, never HTML', async () => {
    const response = await build().request('/nope', {}, env);
    expect(response.status).toBe(404);
    const body = await problemOf(response);
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}not-found`, title: 'Not Found', status: 404 });
    expect(body.instance).toBe(response.headers.get('x-request-id'));
  });

  it('lets the caller replace the 404 for paths the Worker does not own', async () => {
    const app = createWorkerApp<WorkerBaseEnv>({ service: 'test', notFound: (c) => c.text('spa', 200) });
    const response = await app.request('/anything', {}, env);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('spa');
  });

  it('echoes a well-formed X-Request-Id and uses it as the problem instance', async () => {
    const response = await build().request('/nope', { headers: { 'X-Request-Id': 'trace-abc-123' } }, env);
    expect(response.headers.get('x-request-id')).toBe('trace-abc-123');
    expect((await problemOf(response)).instance).toBe('trace-abc-123');
  });

  it('replaces a malformed X-Request-Id instead of reflecting it', async () => {
    const response = await build().request(
      '/ok',
      { headers: { 'X-Request-Id': '<script>alert(1)</script>' } },
      env,
    );
    const id = response.headers.get('x-request-id');
    expect(id).not.toContain('<');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns an unhandled error into a 500 problem without the stack, and logs it redacted', async () => {
    const lines: string[] = [];
    const response = await build((line) => lines.push(line)).request('/boom', {}, env);

    expect(response.status).toBe(500);
    const body = await problemOf(response);
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}internal`, status: 500 });
    expect(JSON.stringify(body)).not.toContain('boom');
    expect(JSON.stringify(body)).not.toContain(JWT_SENTINEL);

    const logged = lines.find((line) => line.includes('unhandled error'));
    expect(logged).toBeDefined();
    expect(logged).toContain('"service":"test"');
    expect(logged).toContain(`"requestId":"${body.instance}"`);
    expect(logged).not.toContain(JWT_SENTINEL);
  });

  it('maps an HTTPException to a problem with the same status and a stable slug', async () => {
    const response = await build().request('/too-big', {}, env);
    expect(response.status).toBe(413);
    expect(await problemOf(response)).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}payload-too-large`,
      title: 'Body too large',
      status: 413,
    });
  });

  it('falls back to a generic slug for statuses without one', async () => {
    const response = await build().request('/teapot', {}, env);
    expect(response.status).toBe(418);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}http-error`);
  });

  it('answers a mapped domain error with its problem and logs only the mapped fields', async () => {
    class UpstreamError extends Error {}
    const lines: string[] = [];
    const app = createWorkerApp<WorkerBaseEnv>({
      service: 'test',
      logSink: (line) => lines.push(line),
      mapError: (error) =>
        error instanceof UpstreamError
          ? {
              problem: { type: 'github-rate-limit', title: 'GitHub rate limit', status: 429, retryAfter: 7 },
              logFields: { githubStatus: 403 },
            }
          : undefined,
    });
    app.get('/mapped', () => {
      throw new UpstreamError(`failed with ${JWT_SENTINEL}`);
    });
    app.get('/unmapped', () => {
      throw new Error('other');
    });

    const mapped = await app.request('/mapped', {}, env);
    expect(mapped.status).toBe(429);
    expect(mapped.headers.get('retry-after')).toBe('7');
    expect((await problemOf(mapped)).type).toBe(`${PROBLEM_TYPE_PREFIX}github-rate-limit`);
    const logged = lines.find((line) => line.includes('request failed')) ?? '';
    expect(JSON.parse(logged)).toMatchObject({
      level: 'warn',
      githubStatus: 403,
      problem: 'github-rate-limit',
    });
    expect(lines.join('\n')).not.toContain(JWT_SENTINEL);

    const unmapped = await app.request('/unmapped', {}, env);
    expect(unmapped.status).toBe(500);
  });

  it('sets Retry-After when a problem carries retryAfter', async () => {
    const response = await build().request('/rate-limited', {}, env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}github-rate-limit`);
  });

  it('adds extension members next to the standard ones', async () => {
    const response = await build().request('/with-step', {}, env);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}project-yml-missing`,
      status: 422,
      step: 'project-yml',
      retryable: false,
      section: null,
      allowed: ['go', 'no-go'],
    });
  });

  it('refuses an extension that would replace a standard member (500, not a forged type)', async () => {
    const response = await build().request('/replaces-type', {}, env);
    expect(response.status).toBe(500);
    expect((await problemOf(response)).type).toBe(`${PROBLEM_TYPE_PREFIX}internal`);
  });
});

describe('security headers (#126)', () => {
  it('sets nosniff and the deny-all CSP on a success response', async () => {
    const response = await build().request('/ok', {}, env);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('sets the same headers on a Problem Details 404 and 500', async () => {
    const notFound = await build().request('/nope', {}, env);
    expect(notFound.headers.get('x-content-type-options')).toBe('nosniff');
    expect(notFound.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");

    const internal = await build().request('/boom', {}, env);
    expect(internal.headers.get('x-content-type-options')).toBe('nosniff');
    expect(internal.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('keeps a header a route set itself instead of overwriting it', async () => {
    const app = createWorkerApp<WorkerBaseEnv>({ service: 'test' });
    app.get('/custom', (c) => c.body(null, 200, { 'X-Content-Type-Options': 'custom-value' }));
    const response = await app.request('/custom', {}, env);
    expect(response.headers.get('x-content-type-options')).toBe('custom-value');
  });

  it('adds Cache-Control: no-store only when noStore is turned on, unless a route set one', async () => {
    const plain = createWorkerApp<WorkerBaseEnv>({ service: 'test' });
    plain.get('/ok', (c) => c.json({ ok: true }));
    const plainResponse = await plain.request('/ok', {}, env);
    expect(plainResponse.headers.get('cache-control')).toBeNull();

    const noStoreApp = createWorkerApp<WorkerBaseEnv>({ service: 'test', noStore: true });
    noStoreApp.get('/ok', (c) => c.json({ ok: true }));
    noStoreApp.get('/own', (c) => c.json({ ok: true }, 200, { 'Cache-Control': 'max-age=60' }));
    const noStoreResponse = await noStoreApp.request('/ok', {}, env);
    expect(noStoreResponse.headers.get('cache-control')).toBe('no-store');
    const ownResponse = await noStoreApp.request('/own', {}, env);
    expect(ownResponse.headers.get('cache-control')).toBe('max-age=60');
  });

  it('leaves a response marked with markAssetResponse untouched', async () => {
    const app = createWorkerApp<WorkerBaseEnv>({
      service: 'test',
      noStore: true,
      notFound: () => markAssetResponse(new Response('<html>spa</html>', { headers: { 'Content-Type': 'text/html' } })),
    });
    const response = await app.request('/anything', {}, env);
    expect(response.headers.get('x-content-type-options')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
