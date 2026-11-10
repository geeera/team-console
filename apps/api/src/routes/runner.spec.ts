import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, runnerAudienceOf, type EnrolRunnerResponse, type RunnerReleaseDto } from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX } from '@shared/redaction';
import { sha256Hex } from '@worker/core';
import { RunnersRepo } from '@worker/db';
import { RUNNER_RATE_LIMIT_PER_MINUTE } from '../auth/runner-auth';
import { localEnv } from '../testing/github-kit';
import {
  createEnrolmentCode,
  enrolBodyOf,
  enrolRunner,
  generateRunnerKey,
  postEnrol,
  runnerJwt,
  sendAsRunner,
} from '../testing/runner-kit';
import { seedSessionUser, sendAsSession } from '../testing/session-kit';
import { send, slugOf } from '../testing/tracker-kit';
import { ENROL_RATE_LIMIT_PER_MINUTE } from './runner';

// #467, ADR 0008 row 2-A: enrolment by a one-time code (threat model C4 "Brute force or theft of an enrolment
// code"), then the runner JWT alone on `/api/v1/runner/*` (ADR 0008 "Customer runner authentication without Access";
// C4 "A stolen runner credential": `exp` <= 5 min, `jti` replay refused, revocation, detection).

const RELEASE = '/api/v1/runner/release';

async function auditKinds(accountId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind FROM audit_events WHERE account_id = ?1 ORDER BY id`,
  )
    .bind(accountId)
    .all<{ kind: string }>();
  return results.map((row) => row.kind);
}

describe('POST /api/v1/runner/enrol', () => {
  it('enrols a runner on a live code: the row, the audit row, the audience, the owner’s name and projects', async () => {
    const { code, expiresAt, audience } = await createEnrolmentCode(OWNER_ACCOUNT_ID, { name: 'Mac mini' });
    expect(code.startsWith(ENROLMENT_CODE_PREFIX)).toBe(true);
    expect(code).toHaveLength(ENROLMENT_CODE_PREFIX.length + 43);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(audience).toBe(runnerAudienceOf('local'));

    const key = await generateRunnerKey();
    const response = await postEnrol(enrolBodyOf(code, key.publicKeyJwk, { isolation: 'container' }));

    expect(response.status).toBe(201);
    const body = (await response.json()) as EnrolRunnerResponse;
    expect(body).toMatchObject({
      accountId: OWNER_ACCOUNT_ID,
      name: 'Mac mini',
      audience: runnerAudienceOf('local'),
      allowedProjects: [],
      pollSeconds: 60,
    });
    const row = await env.DB.prepare(
      `SELECT account_id, name, isolation, public_key_jwk, revoked_at FROM runners WHERE id = ?1`,
    )
      .bind(body.runnerId)
      .first<{ account_id: string; name: string; isolation: string; public_key_jwk: string; revoked_at: null }>();
    expect(row).toMatchObject({ account_id: OWNER_ACCOUNT_ID, name: 'Mac mini', isolation: 'container', revoked_at: null });
    expect(JSON.parse(row?.public_key_jwk ?? '{}')).toEqual(key.publicKeyJwk);
    expect(await auditKinds(OWNER_ACCOUNT_ID)).toEqual(
      expect.arrayContaining(['enrolment-code.created', 'runner.enrolled']),
    );
  });

  it('uses a code once: the second enrol is 401 and writes no runner', async () => {
    const { code } = await createEnrolmentCode(OWNER_ACCOUNT_ID);
    const first = await postEnrol(enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk));
    expect(first.status).toBe(201);
    const second = await postEnrol(enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk));
    expect(second.status).toBe(401);
    expect(await slugOf(second)).toBe('enrolment-code-invalid');
  });

  it.each([
    ['a malformed code', 'not-a-code'],
    ['a code of the right shape nobody made', `${ENROLMENT_CODE_PREFIX}${'A'.repeat(43)}`],
  ])('answers the same 401 for %s', async (_, code) => {
    const response = await postEnrol(enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk));
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('enrolment-code-invalid');
  });

  it('refuses an expired code with the same 401', async () => {
    // An enrolment row is never rewritten (0021 trigger), so the expired code is seeded as such.
    const code = `${ENROLMENT_CODE_PREFIX}${'E'.repeat(43)}`;
    await new RunnersRepo(env.DB).createEnrolment(
      {
        codeHash: await sha256Hex(code),
        accountId: OWNER_ACCOUNT_ID,
        name: 'old',
        allowedProjects: [],
        createdBy: 'owner',
        at: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:10:00.000Z',
      },
      {
        accountId: OWNER_ACCOUNT_ID,
        at: '2026-01-01T00:00:00.000Z',
        actorKind: 'user',
        actor: 'owner',
        kind: 'enrolment-code.created',
        target: null,
      },
    );
    const response = await postEnrol(enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk));
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('enrolment-code-invalid');
  });

  it.each([
    ['a private key member', { publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43), d: 'y'.repeat(43) } }, 'publicKey'],
    ['another curve', { publicKey: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43) } }, 'publicKey'],
    ['an unknown backend', { isolation: 'vm' }, 'isolation'],
    ['a version that is not a release label', { version: 'v 1' }, 'version'],
    ['a concurrency of zero', { capabilities: { local: true, maxConcurrency: 0 } }, 'capabilities.maxConcurrency'],
    ['an extra member', { extra: 1 }, 'body'],
  ])('refuses %s with 422 and the field', async (_, overrides, field) => {
    const { code } = await createEnrolmentCode(OWNER_ACCOUNT_ID);
    const body = { ...enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk), ...overrides };
    const response = await postEnrol(body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('enrol-invalid');
    expect(((await response.json()) as { field: string }).field).toBe(field);
    // The code stays usable: a malformed request spent nothing.
    expect(
      (await postEnrol(enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk))).status,
    ).toBe(201);
  });

  it('refuses the none backend on production (ADR 0008 decision 8) and admits it elsewhere', async () => {
    const { code } = await createEnrolmentCode(OWNER_ACCOUNT_ID);
    const body = enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk, { isolation: 'none' });
    const production = await postEnrol(body, {}, localEnv({ ENVIRONMENT: 'production', AUTH_MODE: undefined }));
    expect(production.status).toBe(422);
    expect(await slugOf(production)).toBe('runner-isolation-none');
    expect((await postEnrol(body)).status).toBe(201);
  });

  it('refuses a code of a suspended account', async () => {
    const owner = await seedSessionUser('owner');
    const { code } = await createEnrolmentCode(owner.account.id, {}, owner);
    await env.DB.prepare(`UPDATE accounts SET suspended_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1`)
      .bind(owner.account.id)
      .run();
    const response = await postEnrol(enrolBodyOf(code, (await generateRunnerKey()).publicKeyJwk));
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('account-suspended');
  });

  it('rate-limits one source address, then answers 429 with Retry-After', async () => {
    const headers = { 'CF-Connecting-IP': '203.0.113.9' };
    const key = (await generateRunnerKey()).publicKeyJwk;
    let last: Response | null = null;
    for (let attempt = 0; attempt < ENROL_RATE_LIMIT_PER_MINUTE + 1; attempt += 1) {
      last = await postEnrol(enrolBodyOf(`${ENROLMENT_CODE_PREFIX}${'B'.repeat(43)}`, key), { headers });
    }
    expect(last?.status).toBe(429);
    expect(await slugOf(last as Response)).toBe('rate-limited');
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Another address is not held by the first one's count.
    const other = await postEnrol(enrolBodyOf(`${ENROLMENT_CODE_PREFIX}${'B'.repeat(43)}`, key), {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
    });
    expect(other.status).toBe(401);
  });

  it('never writes the code or the runner key into a log line', async () => {
    const { code } = await createEnrolmentCode(OWNER_ACCOUNT_ID);
    const key = await generateRunnerKey();
    const lines: string[] = [];
    const response = await postEnrol(enrolBodyOf(code, key.publicKeyJwk), { logSink: (line) => lines.push(line) });
    expect(response.status).toBe(201);
    const output = lines.join('\n');
    expect(output).not.toContain(code);
    expect(output).not.toContain(code.slice(ENROLMENT_CODE_PREFIX.length));
    expect(output).not.toContain(key.publicKeyJwk.x);
  });

  it('is open to the enrolment identity only: a cookie or the local owner carries nothing there', async () => {
    // The route scope admits `enrolment` alone; the auth seam mints it on this path whatever else is sent, so a
    // browser cannot enrol on the owner's behalf through a cross-site POST either (no Sec-Fetch-Site needed, no gain).
    const response = await postEnrol({}, { headers: { Cookie: '__Host-tc_session=x', 'Sec-Fetch-Site': 'cross-site' } });
    expect(response.status).toBe(422);
  });
});

describe('the runner JWT on /api/v1/runner/*', () => {
  it('admits a runner with its own EdDSA JWT and names the release', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const response = await sendAsRunner(runner, 'GET', RELEASE, undefined, {
      bindings: localEnv({ RUNNER_RELEASE_VERSION: '0.2.0', RUNNER_MINIMUM_VERSION: '0.1.0' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as RunnerReleaseDto).toEqual({ version: '0.2.0', minimumVersion: '0.1.0' });
    const seen = await env.DB.prepare(`SELECT last_seen_at FROM runners WHERE id = ?1`)
      .bind(runner.id)
      .first<{ last_seen_at: string | null }>();
    expect(seen?.last_seen_at).not.toBeNull();
  });

  it('answers null for a release the environment does not name', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const response = await sendAsRunner(runner, 'GET', RELEASE);
    expect((await response.json()) as RunnerReleaseDto).toEqual({ version: null, minimumVersion: null });
  });

  it('refuses a call without a JWT, for the local owner and a session user too', async () => {
    const owner = await seedSessionUser('owner');
    for (const response of [
      await send('GET', RELEASE),
      await sendAsSession(owner, 'GET', RELEASE, undefined, {}, localEnv()),
    ]) {
      expect(response.status).toBe(401);
      expect(await slugOf(response)).toBe('runner-jwt-missing');
    }
  });

  it('refuses a JWT signed by another key, naming the runner, with one 401 for unknown and forged', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const impostor = await generateRunnerKey();
    const forged = await sendAsRunner({ id: runner.id, privateKey: impostor.privateKey }, 'GET', RELEASE);
    expect(forged.status).toBe(401);
    expect(await slugOf(forged)).toBe('runner-jwt-invalid');
    const unknown = await sendAsRunner(runner, 'GET', RELEASE, undefined, {
      jwt: { subject: '01M6YSNJ0000000000000NOPE1' },
    });
    expect(unknown.status).toBe(401);
    expect(await slugOf(unknown)).toBe('runner-jwt-invalid');
  });

  it.each([
    ['another environment’s audience', { audience: runnerAudienceOf('production') }, 'runner-jwt-invalid'],
    ['a lifetime over five minutes', { lifetimeSeconds: 301 }, 'runner-jwt-invalid'],
    ['no jti', { omit: ['jti'] as const }, 'runner-jwt-invalid'],
    ['no exp', { omit: ['exp'] as const }, 'runner-jwt-invalid'],
    ['an expired token', { issuedAt: Math.floor(Date.now() / 1000) - 600, lifetimeSeconds: 200 }, 'runner-jwt-expired'],
  ])('refuses %s', async (_, jwt, slug) => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const response = await sendAsRunner(runner, 'GET', RELEASE, undefined, { jwt });
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe(slug);
  });

  it('refuses a token that is not a JWT at all', async () => {
    const response = await send('GET', RELEASE, undefined, { headers: { Authorization: 'Bearer not.a.jwt' } });
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('runner-jwt-invalid');
  });

  it('refuses a replayed jti', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const jti = crypto.randomUUID();
    const first = await sendAsRunner(runner, 'GET', RELEASE, undefined, { jwt: { jti } });
    expect(first.status).toBe(200);
    const replay = await sendAsRunner(runner, 'GET', RELEASE, undefined, { jwt: { jti } });
    expect(replay.status).toBe(401);
    expect(await slugOf(replay)).toBe('runner-jwt-replayed');
  });

  it('refuses a revoked runner', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    await env.DB.prepare(`UPDATE runners SET revoked_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1`)
      .bind(runner.id)
      .run();
    const response = await sendAsRunner(runner, 'GET', RELEASE);
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('runner-revoked');
  });

  it('rate-limits a runner id, then answers 429', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    let last: Response | null = null;
    for (let call = 0; call < RUNNER_RATE_LIMIT_PER_MINUTE + 1; call += 1) {
      last = await sendAsRunner(runner, 'GET', RELEASE);
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('is the runner’s door only: the same JWT on a project route is refused', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const token = await runnerJwt(runner);
    const response = await send('GET', '/api/v1/projects', undefined, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  it('never writes the JWT into a log line', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const lines: string[] = [];
    const token = await runnerJwt(runner);
    const response = await send('GET', RELEASE, undefined, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const bad = await sendAsRunner({ id: runner.id, privateKey: (await generateRunnerKey()).privateKey }, 'GET', RELEASE, undefined, {
      logSink: (line) => lines.push(line),
    });
    expect(bad.status).toBe(401);
    expect(lines.join('\n')).not.toContain('eyJ');
    expect(lines.join('\n')).toContain('runner-jwt-invalid');
  });

  describe('detection (threat model C4)', () => {
    it('marks a runner suspect on a call from a new country and audits it', async () => {
      const runner = await enrolRunner(OWNER_ACCOUNT_ID);
      const ua = { headers: { 'CF-IPCountry': 'UA', 'CF-Connecting-IP': '198.51.100.1' } };
      expect((await sendAsRunner(runner, 'GET', RELEASE, undefined, ua)).status).toBe(200);
      expect((await sendAsRunner(runner, 'GET', RELEASE, undefined, ua)).status).toBe(200);
      const moved = await sendAsRunner(runner, 'GET', RELEASE, undefined, {
        headers: { 'CF-IPCountry': 'DE', 'CF-Connecting-IP': '198.51.100.1' },
      });
      expect(moved.status).toBe(200);
      const row = await env.DB.prepare(`SELECT suspect_reason, seen_countries FROM runners WHERE id = ?1`)
        .bind(runner.id)
        .first<{ suspect_reason: string | null; seen_countries: string }>();
      expect(row).toEqual({ suspect_reason: 'new-country', seen_countries: '["UA","DE"]' });
      const audit = await env.DB.prepare(
        `SELECT details, actor_kind, actor FROM audit_events WHERE kind = 'runner.suspect' AND target = ?1`,
      )
        .bind(runner.id)
        .first<{ details: string; actor_kind: string; actor: string }>();
      expect(audit).toMatchObject({ actor_kind: 'runner', actor: runner.id });
      expect(JSON.parse(audit?.details ?? '{}')).toEqual({ reason: 'new-country', country: 'DE', previousCountry: 'UA' });
    });

    it('marks a runner suspect when two source addresses use its id inside one lease window', async () => {
      const runner = await enrolRunner(OWNER_ACCOUNT_ID);
      await sendAsRunner(runner, 'GET', RELEASE, undefined, {
        headers: { 'CF-IPCountry': 'UA', 'CF-Connecting-IP': '198.51.100.1' },
      });
      await sendAsRunner(runner, 'GET', RELEASE, undefined, {
        headers: { 'CF-IPCountry': 'UA', 'CF-Connecting-IP': '198.51.100.2' },
      });
      const row = await env.DB.prepare(`SELECT suspect_reason, last_seen_ip_hash FROM runners WHERE id = ?1`)
        .bind(runner.id)
        .first<{ suspect_reason: string | null; last_seen_ip_hash: string }>();
      expect(row?.suspect_reason).toBe('two-pollers');
      // The address itself is never stored.
      expect(row?.last_seen_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
