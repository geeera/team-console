import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createWorkerApp } from '@worker/core';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { isOwnerIdentity, ownerOnlyMiddleware } from './owner-only.middleware';

// #434 (threat model #408, C1 row 1): owner-only is an allowlist. The probe app sets the identity itself, so the
// middleware is judged alone, including on a kind `authMiddleware` cannot mint today.

// A kind the union does not have yet (the Phase 2 `job` identity, or any later one): refused by default.
const FUTURE_KIND = { kind: 'job', role: 'pm' } as unknown as Identity;

const LOCAL: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'> = { ENVIRONMENT: 'local', AUTH_MODE: 'local' };

async function probe(identity: Identity, bindings: ApiEnv, lines: string[] = []): Promise<Response> {
  const app = createWorkerApp<ApiEnv>({ service: 'owner-only-probe', logSink: (line) => lines.push(line) });
  app.use('/api/*', async (c, next) => {
    c.set('identity', identity);
    await next();
  });
  app.post('/api/v1/probe', ownerOnlyMiddleware, (c) => c.json({ reached: true }));
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request('http://api.test/api/v1/probe', { method: 'POST' }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

const deployed: ApiEnv = { ...env, ENVIRONMENT: 'dev', AUTH_MODE: '' };
const local: ApiEnv = { ...env, ...LOCAL };

describe('ownerOnlyMiddleware', () => {
  it("lets the owner's Access login through", async () => {
    const response = await probe({ kind: 'user', email: 'owner@example.com' }, deployed);
    expect(response.status).toBe(200);
  });

  it('lets the local bypass through only with ENVIRONMENT=local and AUTH_MODE=local', async () => {
    expect((await probe({ kind: 'local' }, local)).status).toBe(200);
    for (const bindings of [
      deployed,
      { ...env, ENVIRONMENT: 'local', AUTH_MODE: '' },
      { ...env, ENVIRONMENT: 'dev', AUTH_MODE: 'local' },
    ]) {
      const response = await probe({ kind: 'local' }, bindings);
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    }
  });

  it('refuses the service identity with 403 owner-only', async () => {
    const response = await probe({ kind: 'service', commonName: 'ci' }, deployed);
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
  });

  it('refuses an identity of an unknown kind by default and logs the kind as the reason', async () => {
    const lines: string[] = [];
    for (const bindings of [deployed, local]) {
      const response = await probe(FUTURE_KIND, bindings, lines);
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    }
    expect(lines.join('\n')).toContain('"reason":"job"');
  });
});

describe('isOwnerIdentity', () => {
  it('is an allowlist of the owner login and the local bypass', () => {
    expect(isOwnerIdentity({ kind: 'user', email: 'owner@example.com' }, { ENVIRONMENT: 'production' })).toBe(
      true,
    );
    expect(isOwnerIdentity({ kind: 'local' }, LOCAL)).toBe(true);
    expect(isOwnerIdentity({ kind: 'local' }, { ENVIRONMENT: 'production' })).toBe(false);
    expect(isOwnerIdentity({ kind: 'service', commonName: 'ci' }, LOCAL)).toBe(false);
    expect(isOwnerIdentity(FUTURE_KIND, LOCAL)).toBe(false);
  });
});
