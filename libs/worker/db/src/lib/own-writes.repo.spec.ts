import { env } from 'cloudflare:test';
import { OwnWritesRepo, type OwnWrite } from './own-writes.repo';

function write(overrides: Partial<OwnWrite> = {}): OwnWrite {
  return {
    commentId: 1,
    repo: 'geeera/team-console',
    issueNumber: 7,
    kind: 'answer',
    bodyHash: 'hash-a',
    url: 'https://github.com/geeera/team-console/issues/7#issuecomment-1',
    createdAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

describe('OwnWritesRepo', () => {
  const repo = new OwnWritesRepo(env.DB);

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM own_writes').run();
    await env.DB.prepare('DELETE FROM own_write_claims').run();
  });

  it('finds a recorded write by its body hash after `since`', async () => {
    await repo.record(write());
    await expect(
      repo.findRecentByHash('geeera/team-console', 7, 'hash-a', '2026-09-30T09:59:00.000Z'),
    ).resolves.toEqual(write());
  });

  it('finds nothing at or before `since`, for another hash, issue or repository', async () => {
    await repo.record(write());
    await expect(
      repo.findRecentByHash('geeera/team-console', 7, 'hash-a', '2026-09-30T10:00:00.000Z'),
    ).resolves.toBeNull();
    await expect(
      repo.findRecentByHash('geeera/team-console', 7, 'hash-b', '2026-09-30T09:00:00.000Z'),
    ).resolves.toBeNull();
    await expect(
      repo.findRecentByHash('geeera/team-console', 8, 'hash-a', '2026-09-30T09:00:00.000Z'),
    ).resolves.toBeNull();
    await expect(
      repo.findRecentByHash('geeera/other', 7, 'hash-a', '2026-09-30T09:00:00.000Z'),
    ).resolves.toBeNull();
  });

  it('answers the latest of several writes with the same hash', async () => {
    await repo.record(write());
    await repo.record(write({ commentId: 2, createdAt: '2026-09-30T10:05:00.000Z' }));
    await expect(
      repo.findRecentByHash('geeera/team-console', 7, 'hash-a', '2026-09-30T09:00:00.000Z'),
    ).resolves.toMatchObject({ commentId: 2 });
  });

  it('keeps writes without a hash (chat) out of the replay lookup', async () => {
    await repo.record(write({ bodyHash: null }));
    const { results } = await env.DB.prepare('SELECT body_hash FROM own_writes').all();
    expect(results).toEqual([{ body_hash: null }]);
  });

  it('tells a comment the console wrote from any other', async () => {
    await repo.record(write({ commentId: 4242 }));
    await expect(repo.isOwnComment(4242)).resolves.toBe(true);
    await expect(repo.isOwnComment(4243)).resolves.toBe(false);
  });

  it('gives a claim to one holder until it is released or expires', async () => {
    await expect(repo.claim('hash-a', 1_000, 60_000)).resolves.toBe(true);
    await expect(repo.claim('hash-a', 2_000, 60_000)).resolves.toBe(false);
    await expect(repo.claim('hash-b', 2_000, 60_000)).resolves.toBe(true);
    await expect(repo.claim('hash-a', 61_000, 60_000)).resolves.toBe(true);
    await repo.release('hash-a');
    await expect(repo.claim('hash-a', 61_001, 60_000)).resolves.toBe(true);
  });
});
