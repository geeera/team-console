import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { sha256Hex } from '@worker/core';
import { enrolRunner, inOneRateWindow, rateBucketCount, sendAsRunner, withRateBucketAt } from '../testing/runner-kit';
import { seedMembership, seedSessionUser, sendAsSession, type SessionUser } from '../testing/session-kit';
import { send, slugOf } from '../testing/tracker-kit';
import { RUNNER_RATE_LIMIT_PER_MINUTE } from './runner-auth';
import { ACCOUNT_READS_PER_WINDOW, ACCOUNT_READ_WINDOW_SECONDS, accountReadKeyOf } from './account-read-limit.middleware';

// #879: account-scoped GETs are counted per identity per fixed minute; writes, other routes and the runner door
// keep their own limits.

const runnersPath = (accountId: string): string => `/api/v1/accounts/${accountId}/runners`;
const keyOf = (user: SessionUser): string => `account-read:user:${user.userId}`;

describe('accountReadKeyOf', () => {
  it('keys a person by user id, never by account, and the unlinked Access owner as one person', async () => {
    expect(await accountReadKeyOf({ kind: 'user', door: 'session', userId: 'u1', memberships: [] })).toBe('account-read:user:u1');
    expect(await accountReadKeyOf({ kind: 'user', door: 'access', userId: null, memberships: [] })).toBe(
      'account-read:user:access-owner',
    );
  });

  it('hashes a service token’s common name so the key stays short', async () => {
    const commonName = `${'x'.repeat(300)}.access`;
    const key = await accountReadKeyOf({ kind: 'service', commonName });
    expect(key).toBe(`account-read:service:${await sha256Hex(commonName)}`);
    expect(key.length).toBeLessThanOrEqual(255);
  });
});

describe('the account read limit (#879)', () => {
  it('sizes the window so the add-runner wizard’s polls fit several times over', () => {
    const intentPollsPerWindow = ACCOUNT_READ_WINDOW_SECONDS / 3;
    expect(ACCOUNT_READS_PER_WINDOW).toBeGreaterThanOrEqual(intentPollsPerWindow * 5);
  });

  it('counts each account GET once and answers it while under the limit', async () => {
    const owner = await seedSessionUser('owner');
    const outcome = await inOneRateWindow(async () => {
      const before = await rateBucketCount(keyOf(owner));
      const statuses: number[] = [];
      for (const path of ['/api/v1/accounts', runnersPath(owner.account.id), `/api/v1/accounts/${owner.account.id}/settings`]) {
        statuses.push((await sendAsSession(owner, 'GET', path)).status);
      }
      return { statuses, counted: (await rateBucketCount(keyOf(owner))) - before };
    });
    expect(outcome).toEqual({ statuses: [200, 200, 200], counted: 3 });
  });

  it('answers 429 rate-limited with Retry-After once the identity’s reads of the window are spent', async () => {
    const owner = await seedSessionUser('owner');
    const outcome = await inOneRateWindow(async () =>
      withRateBucketAt(keyOf(owner), ACCOUNT_READS_PER_WINDOW - 1, async () => {
        const last = await sendAsSession(owner, 'GET', runnersPath(owner.account.id));
        const over = await sendAsSession(owner, 'GET', runnersPath(owner.account.id));
        const listing = await sendAsSession(owner, 'GET', '/api/v1/accounts');
        return {
          last: last.status,
          over: over.status,
          slug: await slugOf(over),
          retryAfter: Number(over.headers.get('Retry-After')),
          listing: listing.status,
        };
      }),
    );
    expect(outcome).toMatchObject({ last: 200, over: 429, slug: 'rate-limited', listing: 429 });
    expect(outcome.retryAfter).toBeGreaterThanOrEqual(1);
    expect(outcome.retryAfter).toBeLessThanOrEqual(ACCOUNT_READ_WINDOW_SECONDS);
  });

  it('keeps one person’s spent reads from another, and across every account the person belongs to', async () => {
    const alice = await seedSessionUser('owner');
    const bob = await seedSessionUser('owner');
    const second = await seedSessionUser('owner');
    await seedMembership(second.account.id, alice.userId, 'owner');
    const outcome = await inOneRateWindow(async () =>
      withRateBucketAt(keyOf(alice), ACCOUNT_READS_PER_WINDOW, async () => ({
        alice: (await sendAsSession(alice, 'GET', runnersPath(alice.account.id))).status,
        aliceElsewhere: (await sendAsSession(alice, 'GET', runnersPath(second.account.id))).status,
        bob: (await sendAsSession(bob, 'GET', runnersPath(bob.account.id))).status,
      })),
    );
    expect(outcome).toEqual({ alice: 429, aliceElsewhere: 429, bob: 200 });
  });

  it('leaves writes and the project routes to their own limits', async () => {
    const owner = await seedSessionUser('owner');
    const outcome = await inOneRateWindow(async () =>
      withRateBucketAt(keyOf(owner), ACCOUNT_READS_PER_WINDOW, async () => {
        const write = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/enrolment-code`, {
          name: 'Mac',
          projectScope: 'all',
          allowedProjects: [],
        });
        const projects = await sendAsSession(owner, 'GET', '/api/v1/projects');
        return { write: write.status, projects: projects.status, count: await rateBucketCount(keyOf(owner)) };
      }),
    );
    expect(outcome).toEqual({ write: 201, projects: 200, count: ACCOUNT_READS_PER_WINDOW });
  });

  it('does not count a path the route inventory does not list', async () => {
    const owner = await seedSessionUser('owner');
    const outcome = await inOneRateWindow(async () => {
      const before = await rateBucketCount(keyOf(owner));
      const response = await sendAsSession(owner, 'GET', `/api/v1/accounts/${owner.account.id}/no-such-route`);
      return { status: response.status, counted: (await rateBucketCount(keyOf(owner))) - before };
    });
    expect(outcome).toEqual({ status: 404, counted: 0 });
  });

  it('leaves the runner door’s buckets and limits as they were', async () => {
    const runner = await enrolRunner(OWNER_ACCOUNT_ID);
    const outcome = await inOneRateWindow(async () =>
      withRateBucketAt('account-read:local', ACCOUNT_READS_PER_WINDOW, async () => {
        const accountRead = await send('GET', runnersPath(OWNER_ACCOUNT_ID));
        const before = await rateBucketCount(`runner:${runner.id}`);
        const release = await sendAsRunner(runner, 'GET', '/api/v1/runner/release');
        const counted = (await rateBucketCount(`runner:${runner.id}`)) - before;
        const atDoorLimit = await withRateBucketAt(`runner:${runner.id}`, RUNNER_RATE_LIMIT_PER_MINUTE, async () =>
          (await sendAsRunner(runner, 'GET', '/api/v1/runner/release')).status,
        );
        return { accountRead: accountRead.status, release: release.status, counted, atDoorLimit };
      }),
    );
    // The runner's calls count in its own bucket at its own limit, whatever the account reads did.
    expect(outcome).toEqual({ accountRead: 429, release: 200, counted: 1, atDoorLimit: 429 });
    const leaked = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'account-read:runner:%'`).first<{
      n: number;
    }>();
    expect(leaked?.n).toBe(0);
  });
});
