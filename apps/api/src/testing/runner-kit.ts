import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from 'jose';
import {
  runnerAudienceOf,
  type Ed25519PublicJwk,
  type EnrolRunnerInput,
  type EnrolRunnerResponse,
  type EnrolmentCodeDto,
} from '@shared/contracts';
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

/** The owner's request for a code: the local bypass (the owner account) or a signed-in session user. */
export async function createEnrolmentCode(
  accountId: string,
  input: { name?: string; allowedProjects?: readonly string[] } = {},
  as: SessionUser | 'local' = 'local',
): Promise<EnrolmentCodeDto> {
  const body = { name: input.name ?? 'mac', allowedProjects: input.allowedProjects ?? [] };
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

/** A runner enrolled through the API on a fresh code of `accountId`. */
export async function enrolRunner(
  accountId: string,
  options: {
    name?: string;
    allowedProjects?: readonly string[];
    as?: SessionUser | 'local';
    enrol?: Partial<EnrolRunnerInput>;
  } = {},
): Promise<TestRunner> {
  const { code } = await createEnrolmentCode(
    accountId,
    { ...(options.name === undefined ? {} : { name: options.name }), allowedProjects: options.allowedProjects ?? [] },
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
