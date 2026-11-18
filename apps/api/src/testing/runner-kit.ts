import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from 'jose';
import {
  OWNER_ACCOUNT_ID,
  runnerAudienceOf,
  type ClaimResponse,
  type Ed25519PublicJwk,
  type EnrolRunnerInput,
  type EnrolRunnerResponse,
  type EnrolmentCodeDto,
  type EnrolmentIntentCreatedDto,
  type EnrolmentIsolation,
  type RunnerProjectScope,
  type StartEnrolmentInput,
  type StartEnrolmentResponse,
} from '@shared/contracts';
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { RunnersRepo, rateWindowOf } from '@worker/db';
import type { ApiEnv } from '../env';
import { fetchApi, type ApiRequest } from './access-kit';
import { localEnv } from './github-kit';
import { sendAsSession, type SessionUser } from './session-kit';
import { newKey } from './tracker-kit';

/**
 * Test-only kit for the runner door (#467): an Ed25519 key pair as the runner binary would generate one, the
 * enrolment through the API, and runner JWTs signed with that key. The private half lives in the test's memory
 * only, as it lives on the runner host only in production.
 */

export interface TestRunner {
  readonly id: string;
  readonly accountId: string;
  readonly privateKey: CryptoKey | KeyObject;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly enrolment: EnrolRunnerResponse;
}

export async function generateRunnerKey(): Promise<{
  privateKey: CryptoKey | KeyObject;
  publicKeyJwk: Ed25519PublicJwk;
}> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(publicKey);
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('the generated key is not an Ed25519 public JWK');
  }
  return { privateKey, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x } };
}

/**
 * The owner's request for a code: the local bypass (the owner account) or a signed-in session user. The kit's default
 * scope is `selected` (the API's is `all`, #775), so a runner made with no list keeps serving nothing, as the specs
 * written before scopes expect.
 */
export async function createEnrolmentCode(
  accountId: string,
  input: { name?: string; projectScope?: RunnerProjectScope; allowedProjects?: readonly string[] } = {},
  as: SessionUser | 'local' = 'local',
): Promise<EnrolmentCodeDto> {
  const body = {
    name: input.name ?? 'mac',
    projectScope: input.projectScope ?? 'selected',
    allowedProjects: input.allowedProjects ?? [],
  };
  const path = `/api/v1/accounts/${accountId}/runners/enrolment-code`;
  const response =
    as === 'local'
      ? await fetchApi(path, localEnv(), {
          method: 'POST',
          headers: {
            'Sec-Fetch-Site': 'same-origin',
            'Content-Type': 'application/json',
            'Idempotency-Key': newKey(),
          },
          body: JSON.stringify(body),
        })
      : await sendAsSession(as, 'POST', path, body);
  if (response.status !== 201) {
    throw new Error(`creating an enrolment code answered ${String(response.status)}: ${await response.text()}`);
  }
  return (await response.json()) as EnrolmentCodeDto;
}

export function enrolBodyOf(code: string, publicKeyJwk: Ed25519PublicJwk, overrides: Partial<EnrolRunnerInput> = {}): EnrolRunnerInput {
  return {
    code,
    publicKey: publicKeyJwk,
    host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
    capabilities: { local: true, maxConcurrency: 1 },
    isolation: 'user',
    version: '0.1.0',
    ...overrides,
  };
}

const DOOR_WINDOW_SECONDS = 60;

/**
 * Runs `body` until one run starts and ends inside one rate window. The door counters are fixed wall-clock minutes
 * (`rateWindowOf`), so a case that counts to a limit would otherwise flake when it straddles a boundary (#702).
 * `body` must make its own addresses and fixtures, as it may run again.
 */
export async function inOneRateWindow<T>(body: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const window = rateWindowOf(Date.now(), DOOR_WINDOW_SECONDS);
    const result = await body();
    if (rateWindowOf(Date.now(), DOOR_WINDOW_SECONDS) === window) {
      return result;
    }
  }
  throw new Error('a rate window ended inside every run of the case');
}

/**
 * Runs `body` with a door bucket (`oidc:unverified`, `enrol:verified`, …) at `count` in the current window, then puts
 * the bucket back: D1 is shared by a file's cases, so a full bucket must not outlive its case.
 */
export async function withRateBucketAt<T>(key: string, count: number, body: () => Promise<T>): Promise<T> {
  const previous = await rateBucketCount(key);
  await setRateBucket(key, count);
  try {
    return await body();
  } finally {
    await setRateBucket(key, previous);
  }
}

async function setRateBucket(key: string, count: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
  )
    .bind(key, rateWindowOf(Date.now(), DOOR_WINDOW_SECONDS), count)
    .run();
}

/** A bucket's count in the current window, 0 when it has none. */
export async function rateBucketCount(key: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2`)
    .bind(key, rateWindowOf(Date.now(), DOOR_WINDOW_SECONDS))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

let prefixCounter = 0;

/** An IPv6 /64 of its own per call (documentation range), for the per-prefix limit. */
export function uniqueIpv6Prefix(): string {
  prefixCounter += 1;
  return `2001:db8:${prefixCounter.toString(16)}:${(prefixCounter * 7).toString(16)}`;
}

let addressCounter = 0;

/** A source address of its own per call, so the per-address enrol limit judges one case, not the whole file. */
function uniqueAddress(): string {
  addressCounter += 1;
  return `10.${String(Math.floor(addressCounter / 65536) % 256)}.${String(Math.floor(addressCounter / 256) % 256)}.${String(addressCounter % 256)}`;
}

/** `POST /api/v1/runner/enrol` as the runner binary sends it: no cookie, no bearer, no browser headers. */
export async function postEnrol(body: unknown, request: Partial<ApiRequest> = {}, bindings: ApiEnv = localEnv()): Promise<Response> {
  return fetchApi('/api/v1/runner/enrol', bindings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': uniqueAddress(), ...request.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(request.logSink === undefined ? {} : { logSink: request.logSink }),
  });
}

/** The owner's wizard asks for an enrolment intent (#634): the local bypass (the owner account) or a session user. */
export async function createEnrolmentIntent(
  accountId: string,
  input: { name?: string; projectScope?: RunnerProjectScope; allowedProjects?: readonly string[]; isolation?: EnrolmentIsolation } = {},
  as: SessionUser | 'local' = 'local',
): Promise<EnrolmentIntentCreatedDto> {
  const body = {
    name: input.name ?? 'mac',
    projectScope: input.projectScope ?? 'selected',
    allowedProjects: input.allowedProjects ?? [],
    isolation: input.isolation ?? 'user',
  };
  const path = `/api/v1/accounts/${accountId}/runners/enrolment-intents`;
  const response =
    as === 'local'
      ? await fetchApi(path, localEnv(), {
          method: 'POST',
          headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'Idempotency-Key': newKey() },
          body: JSON.stringify(body),
        })
      : await sendAsSession(as, 'POST', path, body);
  if (response.status !== 201) {
    throw new Error(`creating an enrolment intent answered ${String(response.status)}: ${await response.text()}`);
  }
  return (await response.json()) as EnrolmentIntentCreatedDto;
}

export function startBodyOf(
  intentId: string,
  publicKeyJwk: Ed25519PublicJwk,
  overrides: Partial<StartEnrolmentInput> = {},
): StartEnrolmentInput {
  return {
    intentId,
    publicKey: publicKeyJwk,
    host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
    capabilities: { local: true, maxConcurrency: 1 },
    isolation: 'user',
    version: '0.1.0',
    ...overrides,
  };
}

/** A call on an intent's door as the runner binary sends it: no cookie, no bearer, an address of its own. */
export async function postEnrolDoor(
  call: 'start' | 'poll',
  body: unknown,
  request: Partial<ApiRequest> = {},
  bindings: ApiEnv = localEnv(),
): Promise<Response> {
  return fetchApi(`/api/v1/runner/enrol/${call}`, bindings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': uniqueAddress(), ...request.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(request.logSink === undefined ? {} : { logSink: request.logSink }),
  });
}

/** A runner's key bound to a fresh intent of `accountId`, with the poll token only the binder holds. */
export async function bindIntent(
  accountId: string,
  options: Parameters<typeof createEnrolmentIntent>[1] & { as?: SessionUser | 'local'; start?: Partial<StartEnrolmentInput> } = {},
): Promise<{
  readonly intentId: string;
  readonly privateKey: CryptoKey | KeyObject;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly start: StartEnrolmentResponse;
}> {
  const { as, start, ...input } = options;
  const { intentId } = await createEnrolmentIntent(accountId, input, as ?? 'local');
  const key = await generateRunnerKey();
  const response = await postEnrolDoor(
    'start',
    startBodyOf(intentId, key.publicKeyJwk, { isolation: input.isolation ?? 'user', ...start }),
  );
  if (response.status !== 200) {
    throw new Error(`binding answered ${String(response.status)}: ${await response.text()}`);
  }
  return { intentId, ...key, start: (await response.json()) as StartEnrolmentResponse };
}

/** Lets the binder poll again at once: the `slow-down` clock of the intent is put back. */
export async function resetPollClock(intentId: string): Promise<void> {
  await env.DB.prepare(`UPDATE runner_enrolment_requests SET last_polled_at = NULL WHERE id = ?1`).bind(intentId).run();
}

/** A runner enrolled through the API on a fresh code of `accountId`. */
export async function enrolRunner(
  accountId: string,
  options: {
    name?: string;
    projectScope?: RunnerProjectScope;
    allowedProjects?: readonly string[];
    as?: SessionUser | 'local';
    enrol?: Partial<EnrolRunnerInput>;
  } = {},
): Promise<TestRunner> {
  const { code } = await createEnrolmentCode(
    accountId,
    {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.projectScope === undefined ? {} : { projectScope: options.projectScope }),
      allowedProjects: options.allowedProjects ?? [],
    },
    options.as ?? 'local',
  );
  const key = await generateRunnerKey();
  const response = await postEnrol(enrolBodyOf(code, key.publicKeyJwk, options.enrol));
  if (response.status !== 201) {
    throw new Error(`enrolling answered ${String(response.status)}: ${await response.text()}`);
  }
  const enrolment = (await response.json()) as EnrolRunnerResponse;
  return { id: enrolment.runnerId, accountId, ...key, enrolment };
}

export interface RunnerJwtOptions {
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  /** Seconds since the epoch; defaults to now. */
  readonly issuedAt?: number;
  /** Seconds after `issuedAt`; defaults to 240. */
  readonly lifetimeSeconds?: number;
  readonly algorithm?: string;
  readonly omit?: readonly ('jti' | 'exp' | 'iat' | 'aud' | 'sub')[];
}

/** A runner JWT exactly as the runner mints one, unless `options` bend it for a refusal case. */
export async function runnerJwt(
  runner: Pick<TestRunner, 'id' | 'privateKey'>,
  options: RunnerJwtOptions = {},
): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const omit = new Set(options.omit ?? []);
  const jwt = new SignJWT({}).setProtectedHeader({ alg: options.algorithm ?? 'EdDSA' });
  if (!omit.has('sub')) {
    jwt.setSubject(options.subject ?? runner.id);
  }
  if (!omit.has('aud')) {
    jwt.setAudience(options.audience ?? runnerAudienceOf('local'));
  }
  if (!omit.has('iat')) {
    jwt.setIssuedAt(issuedAt);
  }
  if (!omit.has('exp')) {
    jwt.setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 240));
  }
  if (!omit.has('jti')) {
    jwt.setJti(options.jti ?? crypto.randomUUID());
  }
  return jwt.sign(runner.privateKey);
}

/** A job's proxied call (R4): the job token as the bearer, the runner's JWT in `X-Runner-Jwt`. */
export async function sendAsJob(
  runner: Pick<TestRunner, 'id' | 'privateKey'>,
  jobToken: string,
  method: string,
  path: string,
  body?: unknown,
  options: { jwt?: RunnerJwtOptions; headers?: Record<string, string>; bindings?: ApiEnv; logSink?: (line: string) => void } = {},
): Promise<Response> {
  const token = await runnerJwt(runner, options.jwt);
  return fetchApi(path, options.bindings ?? localEnv(), {
    method,
    headers: {
      Authorization: `Bearer ${jobToken}`,
      'X-Runner-Jwt': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': newKey() }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
}

/** Run now, enqueued by the owner through the API; the job's id. */
export async function enqueueJob(slug: string, input: Record<string, unknown> = {}, as: SessionUser | 'local' = 'local'): Promise<string> {
  const body = { kind: 'slot-dev', ...input };
  const path = `/api/v1/projects/${slug}/jobs`;
  const response =
    as === 'local'
      ? await fetchApi(path, localEnv(), {
          method: 'POST',
          headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await sendAsSession(as, 'POST', path, body);
  if (response.status !== 201) {
    throw new Error(`enqueueing answered ${String(response.status)}: ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

/** A call on the runner's door with its JWT, as the runner binary sends it. */
export async function sendAsRunner(
  runner: Pick<TestRunner, 'id' | 'privateKey'>,
  method: string,
  path: string,
  body?: unknown,
  options: { jwt?: RunnerJwtOptions; headers?: Record<string, string>; bindings?: ApiEnv; logSink?: (line: string) => void } = {},
): Promise<Response> {
  const token = await runnerJwt(runner, options.jwt);
  return fetchApi(path, options.bindings ?? localEnv(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
}

/**
 * A claimed job of `slug` with its real `tcj_` token (#612): enqueued by the owner (Run now), claimed by a runner of
 * the owner's account that serves this project alone. The project must hold no other queued job.
 */
export async function seedClaimedJob(
  slug: string,
  kind = 'slot-qa',
): Promise<{ readonly jobId: string; readonly runner: TestRunner; readonly jobToken: string }> {
  const jobId = await enqueueJob(slug, { kind });
  const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [slug] });
  const response = await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {});
  if (response.status !== 200) {
    throw new Error(`claiming answered ${String(response.status)}`);
  }
  const claim = (await response.json()) as ClaimResponse;
  if (claim.job.id !== jobId) {
    throw new Error('the claim took another job than the seeded one');
  }
  return { jobId, runner, jobToken: claim.jobToken };
}

/**
 * The project's access source as the owner sets it on Settings › Team (`PUT …/team-config` on a fresh project; 0032:
 * `projects.access_source` follows the stored document, so the column alone cannot be set).
 */
export async function setProjectAccessSource(
  slug: string,
  accessSource: 'subscription' | 'api_key',
  as: SessionUser | 'local' = 'local',
): Promise<void> {
  const path = `/api/v1/projects/${slug}/team-config`;
  const body = { config: { schema: 'team-config/v1', access: { source: accessSource } } };
  const response =
    as === 'local'
      ? await fetchApi(path, localEnv(), {
          method: 'PUT',
          headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'If-Match': '"0"' },
          body: JSON.stringify(body),
        })
      : await sendAsSession(as, 'PUT', path, body, { headers: { 'If-Match': '"0"' } });
  if (response.status !== 200) {
    throw new Error(`setting the access source answered ${String(response.status)}: ${await response.text()}`);
  }
}

/** The runner's stored allow-list becomes `slugs` (the row only; no cancel batch rides along). */
export const narrowRunner = (runnerId: string, slugs: readonly string[]) => () =>
  env.DB.prepare(`UPDATE runners SET allowed_projects = ?2 WHERE id = ?1`).bind(runnerId, JSON.stringify(slugs)).run();

export const revokeRunner = (runnerId: string) => () =>
  env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(runnerId, new Date().toISOString()).run();

/** As the owner's cancel does: the job leaves the live states and its token is cleared. */
export const cancelJob = (jobId: string) => () =>
  env.DB.prepare(
    `UPDATE jobs SET state = 'cancelled', finished_at = ?2, token_hash = NULL, lease_until = NULL WHERE id = ?1`,
  ).bind(jobId, new Date().toISOString()).run();

/**
 * Cancels every job still in flight — claimed, running, or dispatched to Actions and waiting for its run — as the
 * owner's cancel does. For a file whose cases together hold more jobs than the account's entitled concurrency (#746)
 * admits, run before each case: a file's cases share D1 and the count is account-wide, while each case starts from
 * jobs of its own.
 */
export async function cancelJobsInFlight(): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET state = 'cancelled', finished_at = ?1, token_hash = NULL, lease_until = NULL
     WHERE state IN ('claimed', 'running') OR (state = 'queued' AND dispatched_at IS NOT NULL)`,
  )
    .bind(new Date().toISOString())
    .run();
}

/**
 * Commits `change` once the next runner or job call has passed its JWT checks and read the runner row (during the
 * sighting, the last step of authentication). The caller restores mocks after the test.
 */
export function commitDuringAuthentication(change: () => Promise<unknown>): void {
  const sight = RunnersRepo.prototype.sight;
  vi.spyOn(RunnersRepo.prototype, 'sight').mockImplementationOnce(async function (this: RunnersRepo, ...args) {
    await change();
    return sight.apply(this, args);
  });
}
