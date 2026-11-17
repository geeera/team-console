import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { OWNER_ACCOUNT_ID, runnerAudienceOf } from '@shared/contracts';
import { expect } from './fixtures';

/**
 * A real runner for the console-tracker specs: enrolled through the owner's one-time code with its own Ed25519 key,
 * calling the runner's HTTP API as the binary does (apps/runner/src/client/runner-jwt.ts). No browser.
 */
export interface E2eRunner {
  readonly id: string;
  readonly key: KeyObject;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** EdDSA, `sub` the runner, this environment's audience, 4 minutes, one `jti` per call. */
export function runnerJwt(runner: E2eRunner): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'EdDSA' }));
  const claims = base64url(
    JSON.stringify({
      sub: runner.id,
      aud: runnerAudienceOf('local'),
      iat: now,
      exp: now + 240,
      jti: randomUUID(),
    }),
  );
  return `${header}.${claims}.${base64url(sign(null, Buffer.from(`${header}.${claims}`), runner.key))}`;
}

/** The owner's code for `slug`, then the runner's own enrolment with a fresh key pair. */
export async function enrolRunner(api: APIRequestContext, slug: string): Promise<E2eRunner> {
  const code = await api.post(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
    data: { name: 'E2E Mac', allowedProjects: [slug] },
  });
  expect(code.status(), await code.text()).toBe(201);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const enrolled = await api.post('/api/v1/runner/enrol', {
    data: {
      code: ((await code.json()) as { code: string }).code,
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x },
      host: { os: 'darwin', arch: 'arm64', hostname: 'e2e-mac.local' },
      capabilities: { local: true, maxConcurrency: 1 },
      isolation: 'user',
      version: '0.3.0',
    },
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
  return { id: ((await enrolled.json()) as { runnerId: string }).runnerId, key: privateKey };
}

/** A runner call that must succeed; answers its JSON body, `null` for an empty one. */
export async function asRunner(
  api: APIRequestContext,
  runner: E2eRunner,
  path: string,
  data: unknown,
): Promise<unknown> {
  const response = await api.post(`/api/v1/runner${path}`, {
    data,
    headers: { Authorization: `Bearer ${runnerJwt(runner)}` },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  const text = await response.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
}

/** The status of a claim, whatever it is: 200 a job, 204 nothing to hand out. */
export async function claimStatus(api: APIRequestContext, runner: E2eRunner): Promise<number> {
  const response = await api.post('/api/v1/runner/jobs/claim', {
    data: {},
    headers: { Authorization: `Bearer ${runnerJwt(runner)}` },
  });
  return response.status();
}
