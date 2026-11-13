import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { RUNNER_JWT_MAX_AGE_SECONDS, type JobEventInput } from '@shared/contracts';
import {
  JOB_ID,
  RUNNER_ID,
  fakeConsole,
  jobFixture,
  json,
  problem,
  sentinels,
  type FakeAnswer,
} from '../testing/fake-console';
import { RUNNER_JWT_HEADER, RunnerApiError, RunnerClient } from './runner-client';
import { RUNNER_JWT_LIFETIME_SECONDS, mintRunnerJwt } from './runner-jwt';

const API = 'https://console.example';
const AUDIENCE = 'team-console:dev';
const NOW = new Date('2026-11-13T12:00:00.000Z');

function clientWith(answer: FakeAnswer) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fake = fakeConsole(answer);
  const client = new RunnerClient({
    apiUrl: API,
    runnerId: RUNNER_ID,
    audience: AUDIENCE,
    privateKey,
    fetch: fake.fetch,
    now: () => NOW,
  });
  return { client, publicKey, requests: fake.requests };
}

const bearerOf = (header: string | undefined): string => (header ?? '').replace(/^Bearer /, '');

describe('runner JWT (threat model C4 row 1)', () => {
  it('is EdDSA over the runner key with sub, aud, iat, exp and jti, verifiable by the enrolled public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = mintRunnerJwt({ privateKey, runnerId: RUNNER_ID, audience: AUDIENCE, now: NOW });

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA'],
      audience: AUDIENCE,
      subject: RUNNER_ID,
      currentDate: NOW,
      maxTokenAge: RUNNER_JWT_MAX_AGE_SECONDS,
      requiredClaims: ['sub', 'aud', 'iat', 'exp', 'jti'],
    });
    expect(protectedHeader).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(payload.iat).toBe(NOW.getTime() / 1000);
    expect(payload.exp).toBe(NOW.getTime() / 1000 + RUNNER_JWT_LIFETIME_SECONDS);
  });

  it('lives at most 300 seconds', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = mintRunnerJwt({ privateKey, runnerId: RUNNER_ID, audience: AUDIENCE, now: NOW });
    const { iat = 0, exp = Infinity } = decodeJwt(token);

    expect(exp - iat).toBeLessThanOrEqual(RUNNER_JWT_MAX_AGE_SECONDS);
    expect(exp).toBeGreaterThan(iat);
  });

  it.each([0, -1, 301, 3600, 1.5])('refuses a lifetime of %s seconds', (lifetimeSeconds) => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() =>
      mintRunnerJwt({ privateKey, runnerId: RUNNER_ID, audience: AUDIENCE, now: NOW, lifetimeSeconds }),
    ).toThrow(RangeError);
  });

  it('refuses a key that is not the Ed25519 private key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const publicOnly = generateKeyPairSync('ed25519').publicKey;
    expect(() =>
      mintRunnerJwt({ privateKey: rsa, runnerId: RUNNER_ID, audience: AUDIENCE, now: NOW }),
    ).toThrow(TypeError);
    expect(() =>
      mintRunnerJwt({ privateKey: publicOnly, runnerId: RUNNER_ID, audience: AUDIENCE, now: NOW }),
    ).toThrow(TypeError);
  });

  it('carries a fresh jti on every call, so the console never sees one twice', async () => {
    const { client, requests } = clientWith(() => new Response(null, { status: 204 }));
    await client.claim();
    await client.claim();
    await client.release().catch(() => undefined);

    const jtis = requests.map((request) => decodeJwt(bearerOf(request.headers['authorization'])).jti);
    expect(jtis).toHaveLength(3);
    expect(new Set(jtis).size).toBe(3);
    expect(
      requests.every(
        (request) => decodeProtectedHeader(bearerOf(request.headers['authorization'])).alg === 'EdDSA',
      ),
    ).toBe(true);
  });
});

describe('RunnerClient', () => {
  it('claim: 204 is idle with the console’s Retry-After', async () => {
    const { client, requests } = clientWith(
      () => new Response(null, { status: 204, headers: { 'Retry-After': '45' } }),
    );

    await expect(client.claim()).resolves.toEqual({ kind: 'idle', retryAfterSeconds: 45 });
    expect(requests[0]).toMatchObject({
      url: `${API}/api/v1/runner/jobs/claim`,
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('claim: 204 without a usable Retry-After waits the default minute', async () => {
    const { client } = clientWith(
      () => new Response(null, { status: 204, headers: { 'Retry-After': 'soon' } }),
    );
    await expect(client.claim()).resolves.toEqual({ kind: 'idle', retryAfterSeconds: 60 });
  });

  it('claim: 200 is the job, its token and the lease', async () => {
    const job = jobFixture();
    const { client } = clientWith(() => json(200, { job, jobToken: sentinels.jobToken, leaseSeconds: 300 }));

    await expect(client.claim()).resolves.toEqual({
      kind: 'job',
      job,
      jobToken: sentinels.jobToken,
      leaseSeconds: 300,
    });
  });

  it.each([
    ['a job that is not a JobDto', { job: { id: 'x' }, jobToken: 'tcj_x', leaseSeconds: 300 }],
    ['a token of another shape', { job: jobFixture(), jobToken: 'not-a-token', leaseSeconds: 300 }],
    ['no lease', { job: jobFixture(), jobToken: `tcj_${'a'.repeat(43)}`, leaseSeconds: 0 }],
  ])('claim: refuses %s', async (_label, body) => {
    const { client } = clientWith(() => json(200, body));
    await expect(client.claim()).rejects.toMatchObject({
      name: 'RunnerApiError',
      status: 200,
      problem: null,
    });
  });

  it.each([
    [401, 'runner-jwt-replayed'],
    [401, 'runner-revoked'],
    [429, 'rate-limited'],
    [403, 'runner-isolation-none'],
  ])('claim: %i %s is an error naming the problem', async (status, slug) => {
    const { client } = clientWith(() => problem(status, slug));
    const failure = client.claim();

    await expect(failure).rejects.toBeInstanceOf(RunnerApiError);
    await expect(failure).rejects.toMatchObject({ status, problem: slug });
  });

  it('never follows a redirect (a Location could carry the JWT elsewhere)', async () => {
    const { client, requests } = clientWith(
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }),
    );

    await expect(client.claim()).rejects.toMatchObject({ status: 302 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe('manual');
  });

  it('an error answer that is not JSON names the status, not the body', async () => {
    const { client } = clientWith(() => new Response('<html>secret page</html>', { status: 502 }));
    const failure = client.claim();
    await expect(failure).rejects.toMatchObject({ status: 502, problem: null });
    await expect(failure).rejects.not.toThrow(/secret page/);
  });

  it('release: the console’s release and minimum', async () => {
    const { client, requests } = clientWith(() => json(200, { version: '0.3.0', minimumVersion: '0.2.0' }));

    await expect(client.release()).resolves.toEqual({ version: '0.3.0', minimumVersion: '0.2.0' });
    expect(requests[0]).toMatchObject({ url: `${API}/api/v1/runner/release`, method: 'GET', body: null });
  });

  it('release: refuses an answer that is not a release', async () => {
    const { client } = clientWith(() => json(200, { version: 'not a version!' }));
    await expect(client.release()).rejects.toBeInstanceOf(RunnerApiError);
  });

  it('heartbeat: the new lease end', async () => {
    const { client, requests } = clientWith(() => json(200, { leaseUntil: '2026-11-13T12:05:00.000Z' }));

    await expect(client.heartbeat(JOB_ID)).resolves.toEqual({ leaseUntil: '2026-11-13T12:05:00.000Z' });
    expect(requests[0]?.url).toBe(`${API}/api/v1/runner/jobs/${JOB_ID}/heartbeat`);
  });

  it('heartbeat: 409 job-lease-expired is an error', async () => {
    const { client } = clientWith(() => problem(409, 'job-lease-expired'));
    await expect(client.heartbeat(JOB_ID)).rejects.toMatchObject({
      status: 409,
      problem: 'job-lease-expired',
    });
  });

  it.each(['../claim', 'x/../../projects', '', '01JC00000000000000000000J1/finish'])(
    'refuses a job id that is not a ULID (%s) before any request',
    async (jobId) => {
      const { client, requests } = clientWith(() => json(200, {}));
      await expect(client.heartbeat(jobId)).rejects.toThrow(TypeError);
      await expect(client.events(jobId, [{ level: 'info', kind: 'log', payload: {} }])).rejects.toThrow(
        TypeError,
      );
      await expect(
        client.finish(jobId, { result: 'finished', summary: '', metrics: {}, acted: false }),
      ).rejects.toThrow(TypeError);
      expect(requests).toHaveLength(0);
    },
  );

  it('events: sends batches of at most 50 and answers the last batch', async () => {
    let seq = 0;
    const { client, requests } = clientWith((request) => {
      const count = (JSON.parse(request.body ?? '{}') as { events: unknown[] }).events.length;
      seq += count;
      return json(201, { lastSeq: seq, capped: false });
    });
    const events: JobEventInput[] = Array.from({ length: 120 }, (_, index) => ({
      level: 'info',
      kind: 'log',
      payload: { line: index },
    }));

    await expect(client.events(JOB_ID, events)).resolves.toEqual({ lastSeq: 120, capped: false });
    expect(
      requests.map((request) => (JSON.parse(request.body ?? '{}') as { events: unknown[] }).events.length),
    ).toEqual([50, 50, 20]);
  });

  it('events: refuses an empty list and stops at the first refused batch', async () => {
    const { client, requests } = clientWith(() => problem(422, 'job-events-invalid'));
    await expect(client.events(JOB_ID, [])).rejects.toThrow(RangeError);
    await expect(
      client.events(
        JOB_ID,
        Array.from({ length: 60 }, () => ({ level: 'info', kind: 'log', payload: {} }) as const),
      ),
    ).rejects.toMatchObject({ status: 422, problem: 'job-events-invalid' });
    expect(requests).toHaveLength(1);
  });

  it('finish: posts the result and accepts 200', async () => {
    const { client, requests } = clientWith(() => json(200, jobFixture({ state: 'finished' })));

    await client.finish(JOB_ID, { result: 'finished', summary: 'done', metrics: { turns: 3 }, acted: true });
    expect(requests[0]?.url).toBe(`${API}/api/v1/runner/jobs/${JOB_ID}/finish`);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      result: 'finished',
      summary: 'done',
      metrics: { turns: 3 },
      acted: true,
    });
  });

  it('finish: 409 is an error', async () => {
    const { client } = clientWith(() => problem(409, 'job-lease-expired'));
    await expect(
      client.finish(JOB_ID, { result: 'failed', summary: '', metrics: {}, acted: false }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('forwardForProject: the job token as Bearer and a fresh runner JWT in X-Runner-Jwt; only safe response headers come back', async () => {
    const { client, requests, publicKey } = clientWith(
      () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'tc=1', ETag: '"v1"' },
        }),
    );

    const answer = await client.forwardForProject(sentinels.jobToken, {
      method: 'POST',
      pathAndQuery: '/api/v1/projects/team-console/items',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"x"}',
    });

    expect(answer.status).toBe(201);
    expect(answer.headers).toEqual({ 'content-type': 'application/json', etag: '"v1"' });
    const sent = requests[0];
    expect(sent?.url).toBe(`${API}/api/v1/projects/team-console/items`);
    expect(sent?.headers['authorization']).toBe(`Bearer ${sentinels.jobToken}`);
    expect(sent?.redirect).toBe('manual');
    await expect(
      jwtVerify(sent?.headers[RUNNER_JWT_HEADER.toLowerCase()] ?? '', publicKey, {
        audience: AUDIENCE,
        currentDate: NOW,
      }),
    ).resolves.toBeDefined();
  });

  it('forwardForRunnerJob: the runner JWT is the Bearer and no job token is sent', async () => {
    const { client, requests } = clientWith(() => json(201, { lastSeq: 1, capped: false }));

    await client.forwardForRunnerJob({
      method: 'POST',
      pathAndQuery: `/api/v1/runner/jobs/${JOB_ID}/events`,
      headers: {},
      body: '{"events":[]}',
    });

    expect(decodeJwt(bearerOf(requests[0]?.headers['authorization'])).sub).toBe(RUNNER_ID);
    expect(requests[0]?.headers[RUNNER_JWT_HEADER.toLowerCase()]).toBeUndefined();
  });
});

// #571: the local pause mirrored to the console, on the runner's own door with its JWT.
describe('pause and resume', () => {
  it('posts the pause and its end with a fresh runner JWT, and nothing else', async () => {
    const { client, requests } = clientWith(() => json(200, { pause: null }));
    await client.pause({ reason: 'usage-limit', until: '2026-11-13T13:00:00.000Z' });
    await client.resume();
    expect(requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ['POST', `${API}/api/v1/runner/pause`, JSON.stringify({ reason: 'usage-limit', until: '2026-11-13T13:00:00.000Z' })],
      ['POST', `${API}/api/v1/runner/resume`, '{}'],
    ]);
    const [first, second] = requests.map((request) => bearerOf(request.headers['authorization']));
    expect(first).not.toBe('');
    expect(first).not.toBe(second);
    expect(requests.every((request) => request.redirect === 'manual')).toBe(true);
  });

  it('throws the console’s refusal with its problem slug', async () => {
    const { client } = clientWith(() => problem(422, 'runner-pause-invalid'));
    await expect(client.pause({ reason: 'usage-limit', until: '2026-11-15T13:00:00.000Z' })).rejects.toMatchObject({
      status: 422,
      problem: 'runner-pause-invalid',
    });
    const revoked = clientWith(() => problem(401, 'runner-revoked'));
    await expect(revoked.client.resume()).rejects.toBeInstanceOf(RunnerApiError);
  });
});
