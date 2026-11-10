import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createWorkerApp } from '@worker/core';
import type { Identity } from '../auth/auth.types';
import type { ApiEnv } from '../env';
import { ownerOrServiceRefusal } from './lookup';

// #482 review: the one gate for the routes that stay the environment owner's until T-4 (`POST /projects`,
// `GET /github/installation/repositories`), unit-tested apart from those routes: who passes, who is refused, and
// that the log names the identity kind only.

const IDENTITIES: Readonly<Record<string, Identity>> = {
  'access-owner': {
    kind: 'user',
    door: 'access',
    userId: null,
    memberships: [{ accountId: OWNER_ACCOUNT_ID, role: 'owner' }],
  },
  'session-owner': {
    kind: 'user',
    door: 'session',
    userId: '01M6YSNJ00000000000000VS99',
    memberships: [{ accountId: OWNER_ACCOUNT_ID, role: 'owner' }],
  },
  local: { kind: 'local' },
  service: { kind: 'service', commonName: 'ci' },
  job: { kind: 'job', role: 'pm', projectSlug: 'acme', jobId: 'job-1', items: [] },
};

const DETAIL = 'This route is the environment owner’s until T-4';

/** A minimal Worker app: the identity comes from a test header, the gate answers or the route says ok. */
async function probe(
  who: keyof typeof IDENTITIES,
  bindings: Partial<ApiEnv>,
  lines: string[] = [],
): Promise<Response> {
  const app = createWorkerApp<ApiEnv>({ service: 'api', logSink: (line) => lines.push(line) });
  app.use('*', async (c, next) => {
    const identity = IDENTITIES[c.req.header('x-test-identity') ?? ''];
    if (identity === undefined) {
      throw new Error('unknown test identity');
    }
    c.set('identity', identity);
    await next();
  });
  app.post('/gated', (c) => ownerOrServiceRefusal(c, DETAIL) ?? c.text('ok'));
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request('http://api.test/gated', { method: 'POST', headers: { 'x-test-identity': who } }),
    { ...env, ...bindings } as ApiEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

const LOCAL = { ENVIRONMENT: 'local', AUTH_MODE: 'local' };
const DEPLOYED = { ENVIRONMENT: 'dev', AUTH_MODE: undefined };

describe('ownerOrServiceRefusal', () => {
  it('passes the Access owner, the service identity and the local bypass', async () => {
    expect((await probe('access-owner', DEPLOYED)).status).toBe(200);
    expect((await probe('service', DEPLOYED)).status).toBe(200);
    expect((await probe('local', LOCAL)).status).toBe(200);
  });

  it.each([
    ['a session user, whatever it owns', 'session-owner', DEPLOYED],
    ['a job', 'job', LOCAL],
    ['the local kind outside the bypass', 'local', DEPLOYED],
  ] as const)('refuses %s with 403 owner-only and the route’s detail', async (_, who, bindings) => {
    const response = await probe(who, bindings);
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
    expect(((await response.json()) as { detail: string }).detail).toBe(DETAIL);
  });

  it('logs the identity kind as the reason, never the user id', async () => {
    const lines: string[] = [];
    await probe('session-owner', DEPLOYED, lines);
    const log = lines.join('\n');
    expect(log).toContain('"message":"owner route refused"');
    expect(log).toContain('"reason":"user"');
    expect(log).not.toContain('01M6YSNJ00000000000000VS99');
  });
});
