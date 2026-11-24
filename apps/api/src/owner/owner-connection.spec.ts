import { env } from 'cloudflare:test';
import { sealText } from '@worker/core';
import { OwnerConnectionsRepo, type SealedTokenPair } from '@worker/db';
import { GitHubError } from '@worker/github';
import { mapGitHubError } from '../github';
import {
  ENVIRONMENT,
  OWNER,
  fakeGitHub,
  oauthOver,
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

// #86 item 1, #831: a reconnect stores the new pair, then retires the previous one, best effort.
describe('OwnerConnection.connect', () => {
  const TOKEN_REVOKE = `DELETE https://api.github.com/applications/${env.GITHUB_APP_CLIENT_ID}/token`;
  const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';

  function revokesIn(fake: ReturnType<typeof fakeGitHub>): string[] {
    return fake.calls.filter((c) => c.method === 'DELETE').map((c) => `${c.method} ${c.url}`);
  }

  function freshPair(fake: ReturnType<typeof fakeGitHub>, user = OWNER) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      ...fake.issuePair(user),
      accessExpiresAt: nowSeconds + 3600,
      refreshExpiresAt: nowSeconds + 86_400,
    };
  }

  function reasonsFor(logs: readonly string[], message: string): unknown[] {
    return parsedLogs(logs)
      .filter((line) => line['message'] === message)
      .map((line) => line['reason']);
  }

  const notRevokedReasons = (logs: readonly string[]) =>
    reasonsFor(logs, 'owner reconnect: the previous access token was not revoked');
  const chainNotEndedReasons = (logs: readonly string[]) =>
    reasonsFor(logs, 'owner reconnect: the previous refresh chain was not ended');

  async function isRefreshTokenRedeemable(fake: ReturnType<typeof fakeGitHub>, refreshToken: string) {
    const answer = await fake.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
    return Object.hasOwn((await answer.json()) as object, 'access_token');
  }

  it('a first connect calls GitHub not at all', async () => {
    const fake = fakeGitHub();
    await expect((await ownerConnection(fake)).connect(OWNER, freshPair(fake))).resolves.toBe('connected');
    expect(fake.calls).toEqual([]);
    expect(await storedRow()).toMatchObject({ login: OWNER.login, user_id: OWNER.id });
  });

  it('ends the previous pair: its access token, its refresh token and the access token redeeming it issued', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const previous = await seedConnection(fake);
    const next = freshPair(fake);

    await expect((await ownerConnection(fake, { logs })).connect(OWNER, next)).resolves.toBe('connected');

    expect(revokesIn(fake)).toEqual([TOKEN_REVOKE, TOKEN_REVOKE]);
    expect(fake.refreshCalls()).toBe(1);
    expect(fake.isAccessTokenLive(previous.accessToken)).toBe(false);
    expect(await isRefreshTokenRedeemable(fake, previous.refreshToken)).toBe(false);
    // The grant and the new pair stay live: a grant revoke would disconnect the owner.
    expect(fake.isAccessTokenLive(next.accessToken)).toBe(true);
    expect(fake.activeGrants()).toBe(1);
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
    const messages = parsedLogs(logs).map((line) => line['message']);
    expect(messages).toContain('owner reconnect: the previous access token was revoked');
    expect(messages).toContain('owner reconnect: the previous redeemed access token was revoked');
    expect(messages).toContain('owner reconnect: the previous refresh chain was ended');
    expect(logs.join('\n')).not.toMatch(/gh[ur]_/);
  });

  it('a failed write retires nothing: the previous pair still works', async () => {
    const fake = fakeGitHub();
    const previous = await seedConnection(fake);
    class FailingConnect extends OwnerConnectionsRepo {
      override async connect(): Promise<boolean> {
        throw new Error('D1_ERROR: simulated write failure');
      }
    }
    const failing = await ownerConnection(fake, { repo: new FailingConnect(env.DB) });

    await expect(failing.connect(OWNER, freshPair(fake))).rejects.toThrow('simulated write failure');

    expect(fake.calls).toEqual([]);
    expect(fake.isAccessTokenLive(previous.accessToken)).toBe(true);
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(previous.accessToken);
  });

  it('GitHub rejecting the previous token (already gone) is logged and the connect goes on', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const previous = await seedConnection(fake);
    await fake.fetch(`https://api.github.com/applications/${env.GITHUB_APP_CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET ?? ''}`)}`,
      },
      body: JSON.stringify({ access_token: previous.accessToken }),
    });
    const next = freshPair(fake);

    await (await ownerConnection(fake, { logs })).connect(OWNER, next);

    expect(notRevokedReasons(logs)).toEqual(['token-rejected']);
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
  });

  it('a GitHub 5xx on the revoke is logged and the connect goes on', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const previous = await seedConnection(fake);
    fake.fail('token-revoke-unavailable');
    const next = freshPair(fake);

    await (await ownerConnection(fake, { logs })).connect(OWNER, next);

    expect(notRevokedReasons(logs)).toEqual(['revoke-failed']);
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
    // The redemption still ended the chain, and with it the access token GitHub would not revoke.
    expect(fake.isAccessTokenLive(previous.accessToken)).toBe(false);
  });

  it('a GitHub 5xx on the redemption is logged and the connect goes on', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const previous = await seedConnection(fake);
    fake.fail('refresh-unavailable');
    const next = freshPair(fake);

    await (await ownerConnection(fake, { logs })).connect(OWNER, next);

    expect(chainNotEndedReasons(logs)).toEqual(['refresh-failed']);
    expect(await isRefreshTokenRedeemable(fake, previous.refreshToken)).toBe(true);
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
  });

  it('a previous refresh token GitHub refuses (already redeemed) is logged as dead and the connect goes on', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const previous = await seedConnection(fake);
    await isRefreshTokenRedeemable(fake, previous.refreshToken);
    const next = freshPair(fake);

    await (await ownerConnection(fake, { logs })).connect(OWNER, next);

    expect(parsedLogs(logs)).toContainEqual(
      expect.objectContaining({
        message: 'owner reconnect: the previous refresh token was already dead',
        error: 'bad_refresh_token',
      }),
    );
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
  });

  // #901: anything but a GitHubError while retiring is a bug, not GitHub's answer; the new pair is stored already.
  it.each(['revokeToken', 'refresh'] as const)(
    'an unexpected error from %s while retiring is logged and the connect still answers connected',
    async (method) => {
      const fake = fakeGitHub();
      const logs: string[] = [];
      await seedConnection(fake);
      const next = freshPair(fake);
      const oauth = oauthOver(fake);
      vi.spyOn(oauth, method).mockRejectedValue(new TypeError('unexpected while retiring'));

      await expect((await ownerConnection(fake, { logs, oauth })).connect(OWNER, next)).resolves.toBe(
        'connected',
      );

      const failures = parsedLogs(logs).filter(
        (line) => line['message'] === 'owner reconnect: retiring the previous pair failed unexpectedly',
      );
      expect(failures).toEqual([
        expect.objectContaining({
          level: 'error',
          securitySignal: 'owner-previous-pair-not-retired',
          error: expect.objectContaining({ name: 'TypeError', message: 'unexpected while retiring' }),
        }),
      ]);
      expect(logs.join('\n')).not.toMatch(/gh[ur]_/);
      await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
    },
  );

  it.each([
    ['expired', 'UPDATE owner_connections SET access_expires_at = 1, refresh_expires_at = 1'],
    [
      'undecryptable',
      "UPDATE owner_connections SET access_token_enc = 'ff' || substr(access_token_enc, 3), refresh_token_enc = 'ff' || substr(refresh_token_enc, 3)",
    ],
    ['under another master key', "UPDATE owner_connections SET key_id = '00000000'"],
  ])(
    'a previous pair that is %s is not sent to GitHub; logged, and the connect goes on',
    async (_label, sql) => {
      const fake = fakeGitHub();
      const logs: string[] = [];
      await seedConnection(fake);
      await env.DB.prepare(sql).run();
      const next = freshPair(fake);

      await (await ownerConnection(fake, { logs })).connect(OWNER, next);

      expect(fake.calls).toEqual([]);
      expect(notRevokedReasons(logs)).toEqual(['no-usable-token']);
      expect(chainNotEndedReasons(logs)).toEqual(['no-usable-token']);
      await expect((await ownerConnection(fake)).getToken()).resolves.toBe(next.accessToken);
    },
  );

  it('a changed GitHub user id is refused: a security signal, nothing stored, nothing sent to GitHub', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const previous = await seedConnection(fake);
    const before = await storedRow();
    const other = { login: OWNER.login, id: 4242 };

    await expect(
      (await ownerConnection(fake, { logs })).connect(other, freshPair(fake, other)),
    ).resolves.toBe('user-id-changed');

    expect(fake.calls).toEqual([]);
    expect(await storedRow()).toEqual(before);
    // The callback logs the refusal, once, with the revoke outcome (#901).
    expect(logs).toEqual([]);
    await expect((await ownerConnection(fake)).getToken()).resolves.toBe(previous.accessToken);
  });

  it('another account winning the first-connect race is not overwritten: the late callback is refused (#889)', async () => {
    const fake = fakeGitHub();
    const logs: string[] = [];
    const rival = { login: OWNER.login, id: 4242 };
    // The rival's callback stores its row between our read (empty) and our write.
    class RacedRepo extends OwnerConnectionsRepo {
      override async find(environment: string) {
        await super.connect({
          environment,
          login: rival.login,
          userId: rival.id,
          accessTokenEnc: 'rival-access',
          refreshTokenEnc: 'rival-refresh',
          accessExpiresAt: 1,
          refreshExpiresAt: 1,
          keyId: 'rival',
          now: new Date().toISOString(),
        });
        return null;
      }
    }
    const raced = await ownerConnection(fake, { repo: new RacedRepo(env.DB), logs });

    await expect(raced.connect(OWNER, freshPair(fake))).resolves.toBe('user-id-changed');

    expect(await storedRow()).toMatchObject({
      user_id: rival.id,
      access_token_enc: 'rival-access',
      version: 1,
    });
    expect(fake.calls).toEqual([]);
    // The callback logs the refusal, once, with the revoke outcome (#901).
    expect(logs).toEqual([]);
  });
});
