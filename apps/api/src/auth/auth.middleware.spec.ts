import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails } from '@shared/contracts';
import { createApiApp } from '../app';
import type { ApiEnv } from '../env';

// The pool binds ENVIRONMENT=local + AUTH_MODE=local for the other specs; each case here overrides them.
async function fetchWith(overrides: Partial<Record<'ENVIRONMENT' | 'AUTH_MODE', string | undefined>>) {
  const ctx = createExecutionContext();
  const bindings: ApiEnv = { ...env, ...overrides };
  const response = await createApiApp().fetch(new Request('http://api.test/api/v1/projects'), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function expectAccessMissing(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body: unknown = await response.json();
  expect(isProblemDetails(body)).toBe(true);
  expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}access-missing`, status: 401 });
}

describe('authMiddleware (fail-closed placeholder until #8)', () => {
  it('rejects an /api/v1 request under the dev config with 401 access-missing', async () => {
    await expectAccessMissing(await fetchWith({ ENVIRONMENT: 'dev', AUTH_MODE: undefined }));
  });

  it('rejects AUTH_MODE=local without ENVIRONMENT=local (threat model #8, row 7)', async () => {
    await expectAccessMissing(await fetchWith({ ENVIRONMENT: 'stage', AUTH_MODE: 'local' }));
  });

  it('rejects ENVIRONMENT=local without AUTH_MODE=local', async () => {
    await expectAccessMissing(await fetchWith({ ENVIRONMENT: 'local', AUTH_MODE: undefined }));
  });

  it('lets a request through only when both local flags are set', async () => {
    const response = await fetchWith({ ENVIRONMENT: 'local', AUTH_MODE: 'local' });
    expect(response.status).toBe(200);
  });
});
