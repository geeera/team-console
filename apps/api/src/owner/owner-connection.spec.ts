import { env } from 'cloudflare:test';
import { sealText } from '@worker/core';
import { OwnerConnectionsRepo, type SealedTokenPair } from '@worker/db';
import { GitHubError } from '@worker/github';
import { mapGitHubError } from '../github';
import {
  ENVIRONMENT,
  OWNER,
  fakeGitHub,
  ownerConnection,
  parsedLogs,
  resetOwnerConnections,
  seedConnection,
  storedRow,
} from '../testing/owner-kit';
import { LEASE_WAIT_ATTEMPTS, LEASE_WAIT_MS } from './owner-connection';
import { loadOwnerKeys } from './owner-keys';

const NOT_CONNECTED = {
  type: 'github-owner-not-connected',
  status: 403,
  extensions: { connectUrl: '/api/v1/github/connect' },
};

async function errorOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubError');
}

function signalsIn(logs: readonly string[]): Record<string, unknown>[] {
  return parsedLogs(logs).filter((line) => line['securitySignal'] === 'owner-not-connected');
}

beforeEach(async () => {
  await resetOwnerConnections();
});

describe('OwnerConnection.getToken', () => {
  it('without a connection → 403 github-owner-not-connected with connectUrl, and no security signal', async () => {
    const logs: string[] = [];
    const error = await errorOf((await ownerConnection(fakeGitHub(), { logs })).getToken());
    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(signalsIn(logs)).toEqual([]);
  });

  it('returns the stored token while more than 30 minutes are left, without calling GitHub', async () => {
    const fake = fakeGitHub();
    const seeded = await seedConnection(fake, { accessSecondsLeft: 31 * 60 });

    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(seeded.accessToken);
    expect(fake.calls).toEqual([]);
  });

  it('refreshes with less than 30 minutes left: stores the new pair over the version and clears the lease', async () => {
    const fake = fakeGitHub();
    const seeded = await seedConnection(fake, { accessSecondsLeft: 29 * 60 });
    const before = await storedRow();

    const token = await (await ownerConnection(fake)).getToken();

    expect(token).not.toBe(seeded.accessToken);
    expect(fake.refreshCalls()).toBe(1);
    const after = await storedRow();
    expect(after).toMatchObject({
      version: 2,
      refreshing_until: null,
      login: OWNER.login,
      user_id: OWNER.id,
    });
    expect(after?.access_token_enc).not.toBe(before?.access_token_enc);
    expect(after?.refresh_token_enc).not.toBe(before?.refresh_token_enc);
    // The next request uses the stored new pair without another refresh.
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(token);
    expect(fake.refreshCalls()).toBe(1);
  });

  it('refreshes once more after the caller invalidated a token GitHub answered 401 to', async () => {
    const fake = fakeGitHub();
    const seeded = await seedConnection(fake);
    const connection = await ownerConnection(fake);

    connection.invalidate(seeded.accessToken);

    await expect(connection.getToken()).resolves.not.toBe(seeded.accessToken);
    expect(fake.refreshCalls()).toBe(1);
  });

  // Decision 4, named test 1.
  it('two concurrent refreshes: one GitHub call, both callers end with the new pair', async () => {
    const fake = fakeGitHub({ refreshDelayMs: 300 });
    await seedConnection(fake, { accessSecondsLeft: 60 });
    const [first, second] = await Promise.all([ownerConnection(fake), ownerConnection(fake)]);

    const tokens = await Promise.all([first?.getToken(), second?.getToken()]);

    expect(fake.refreshCalls()).toBe(1);
    expect(tokens[0]).toBe(tokens[1]);
    expect(await storedRow()).toMatchObject({ version: 2, refreshing_until: null });
  });

  // Decision 4, named test 2.
  it('GitHub refreshed but the D1 write failed: the next caller after the lease ends in a clean 403', async () => {
    const fake = fakeGitHub();
    let nowMs = Date.now();
    await seedConnection(fake, { accessSecondsLeft: 60, nowMs });
    class FailingWrite extends OwnerConnectionsRepo {
      override async storeRefreshed(): Promise<boolean> {
        throw new Error('D1_ERROR: simulated write failure');
      }
    }
    const failing = await ownerConnection(fake, {
      now: () => nowMs,
      repo: new FailingWrite(env.DB),
    });

    await expect(failing.getToken()).rejects.toThrow('simulated write failure');
    expect(await storedRow()).toMatchObject({ version: 1 });
    expect((await storedRow())?.refreshing_until).not.toBeNull();

    nowMs += 61_000;
    const logs: string[] = [];
    const next = await ownerConnection(fake, { now: () => nowMs, logs });
    const error = await errorOf(next.getToken());

    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(fake.refreshCalls()).toBe(2);
    expect(await storedRow()).toBeNull();
    expect(signalsIn(logs)).toEqual([expect.objectContaining({ reason: 'refresh-refused' })]);
  });

  // Decision 4, named test 3.
  it('bad_refresh_token while the version moved on: no delete, the caller re-reads and gets the newer pair', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake, { accessSecondsLeft: 60 });
    const newer = fake.issuePair(OWNER);
    const keys = await loadOwnerKeys(env.TOKEN_ENCRYPTION_KEY, ENVIRONMENT);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sealed: SealedTokenPair = {
      accessTokenEnc: await sealText(keys.tokenKey, newer.accessToken, `${ENVIRONMENT}:access_token_enc`),
      refreshTokenEnc: await sealText(keys.tokenKey, newer.refreshToken, `${ENVIRONMENT}:refresh_token_enc`),
      accessExpiresAt: nowSeconds + 8 * 60 * 60,
      refreshExpiresAt: nowSeconds + 3600,
      keyId: keys.keyId,
    };
    // Another isolate writes a fresh pair between our lease and our reaction to bad_refresh_token.
    class RacedRepo extends OwnerConnectionsRepo {
      override async deleteAtVersion(environment: string, version: number): Promise<boolean> {
        await this.storeRefreshed(environment, version, sealed, new Date().toISOString());
        return super.deleteAtVersion(environment, version);
      }
    }
    fake.fail('refresh-bad-refresh-token');
    const logs: string[] = [];
    const connection = await ownerConnection(fake, { repo: new RacedRepo(env.DB), logs });

    await expect(connection.getToken()).resolves.toBe(newer.accessToken);
    expect(await storedRow()).toMatchObject({ version: 2 });
    expect(signalsIn(logs)).toEqual([]);
  });

  it('bad_refresh_token at the current version: the row is deleted, 403, and a security signal is logged', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake, { accessSecondsLeft: 60 });
    fake.fail('refresh-bad-refresh-token');
    const logs: string[] = [];

    const error = await errorOf((await ownerConnection(fake, { logs })).getToken());

    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(await storedRow()).toBeNull();
    expect(signalsIn(logs)).toEqual([
      expect.objectContaining({ level: 'warn', reason: 'refresh-refused', error: 'bad_refresh_token' }),
    ]);
  });

  it('a GitHub 5xx on refresh throws, keeps the row and leaves the lease to expire', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake, { accessSecondsLeft: 60 });
    fake.fail('refresh-unavailable');

    const error = await errorOf((await ownerConnection(fake)).getToken());

    expect(error.problem).toMatchObject({ type: 'github-unavailable', status: 502 });
    const row = await storedRow();
    expect(row).toMatchObject({ version: 1 });
    expect(row?.refreshing_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('a waiter re-reads at most 5 × 200 ms, then uses the still-valid token', async () => {
    const fake = fakeGitHub();
    const seeded = await seedConnection(fake, { accessSecondsLeft: 60 });
    const row = await storedRow();
    await new OwnerConnectionsRepo(env.DB).takeRefreshLease(
      ENVIRONMENT,
      row?.version ?? 0,
      Math.floor(Date.now() / 1000),
      60,
    );
    const waits: number[] = [];

    const token = await (
      await ownerConnection(fake, { sleep: async (ms) => void waits.push(ms) })
    ).getToken();

    expect(token).toBe(seeded.accessToken);
    expect(waits).toEqual(Array.from({ length: LEASE_WAIT_ATTEMPTS }, () => LEASE_WAIT_MS));
    expect(fake.calls).toEqual([]);
  });

  it('a waiter whose token has already expired gives up with a retryable 503', async () => {
    const fake = fakeGitHub();
    const nowMs = Date.now();
    await seedConnection(fake, { accessSecondsLeft: -5, nowMs });
    await new OwnerConnectionsRepo(env.DB).takeRefreshLease(ENVIRONMENT, 1, Math.floor(nowMs / 1000), 60);

    const error = await errorOf(
      (await ownerConnection(fake, { now: () => nowMs, sleep: async () => undefined })).getToken(),
    );

    expect(error.problem).toMatchObject({ type: 'github-unavailable', status: 503, retryAfter: 1 });
  });

  it('an expired refresh token → the row is deleted and 403', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake, { accessSecondsLeft: 60, refreshSecondsLeft: -1 });
    const logs: string[] = [];

    const error = await errorOf((await ownerConnection(fake, { logs })).getToken());

    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(await storedRow()).toBeNull();
    expect(signalsIn(logs)).toEqual([expect.objectContaining({ reason: 'refresh-token-expired' })]);
  });
});

describe('unusable rows (decision 4, threat model row 8)', () => {
  // Decision 4, named test 4.
  it('decrypt failure → 403 with connectUrl, the row is gone, a security signal naming the runbook — never a 500', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake);
    const row = await storedRow();
    const flipped = `${row?.access_token_enc.slice(0, -1)}${row?.access_token_enc.endsWith('0') ? '1' : '0'}`;
    await env.DB.prepare('UPDATE owner_connections SET access_token_enc = ?1').bind(flipped).run();
    const logs: string[] = [];

    const error = await errorOf((await ownerConnection(fake, { logs })).getToken());

    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(mapGitHubError(error)?.problem.status).toBe(403);
    expect(await storedRow()).toBeNull();
    const [signal] = signalsIn(logs);
    expect(signal).toMatchObject({ level: 'warn', reason: 'decrypt-failed', column: 'access_token_enc' });
    expect(String(signal?.['runbook'])).toContain('revoke all user tokens');
    expect(logs.join('\n')).not.toContain(flipped);
  });

  it('an access ciphertext moved into the refresh column does not decrypt (AAD binds the column)', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake, { accessSecondsLeft: 60 });
    await env.DB.prepare('UPDATE owner_connections SET refresh_token_enc = access_token_enc').run();

    const error = await errorOf((await ownerConnection(fake)).getToken());

    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(await storedRow()).toBeNull();
    expect(fake.refreshCalls()).toBe(0);
  });

  it('a key_id mismatch (the master key was rotated) → 403, the row is gone, both key ids logged', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake);
    const logs: string[] = [];
    const rotated = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

    const connection = await ownerConnection(fake, { logs, masterKey: rotated });
    const error = await errorOf(connection.getToken());

    expect(error.problem).toMatchObject(NOT_CONNECTED);
    expect(await storedRow()).toBeNull();
    expect(signalsIn(logs)).toEqual([
      expect.objectContaining({
        reason: 'key-id-mismatch',
        storedKeyId: expect.stringMatching(/^[0-9a-f]{8}$/),
        expectedKeyId: expect.stringMatching(/^[0-9a-f]{8}$/),
      }),
    ]);
  });

  it('stores ciphertext only: no ghu_/ghr_ in the row', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake);
    const serialised = JSON.stringify(await storedRow());
    expect(serialised).not.toContain('ghu_');
    expect(serialised).not.toContain('ghr_');
  });
});

describe('OwnerConnection.account', () => {
  it('is the login and numeric id pinned at connect', async () => {
    const fake = fakeGitHub();
    await seedConnection(fake);
    await expect((await ownerConnection(fake)).account()).resolves.toEqual({ login: 'geeera', userId: 1001 });
  });
});
