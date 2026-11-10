import { env } from 'cloudflare:test';
import { PullRequestsRepo, type PullRequestSnapshot } from './pull-requests.repo';

const repo = (): PullRequestsRepo => new PullRequestsRepo(env.DB);
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const SYNCED = '2026-11-09T12:00:00.000Z';

function pull(number: number, extra: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    externalId: String(5_000_000 + number),
    number,
    title: `PR ${String(number)}`,
    state: 'open',
    draft: false,
    headRef: `feature/${String(number)}`,
    headSha: HEAD,
    baseRef: 'dev',
    authorLogin: 'geeera',
    url: `https://github.com/geeera/storify/pull/${String(number)}`,
    updatedAt: '2026-11-09T10:00:00.000Z',
    ...extra,
  };
}

async function seedProject(slug: string, repoId: number | null, archived = false): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, added_at, archived_at, repo_id) VALUES (?1, ?2, ?1, ?3, ?4, ?5)',
  )
    .bind(slug, `geeera/${slug}`, '2026-11-01T00:00:00Z', archived ? '2026-11-02T00:00:00Z' : null, repoId)
    .run();
}

const write = { repositoryId: 860001, syncedAt: SYNCED } as const;

describe('PullRequestsRepo', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM pull_requests').run();
    await env.DB.prepare('DELETE FROM projects').run();
    await seedProject('storify', 860001);
    await seedProject('legacy', null);
    await seedProject('gone', null, true);
  });

  it('inserts a pull request with its CI unknown and stale, and reads it back', async () => {
    await expect(repo().upsert('storify', pull(7), write)).resolves.toBe(true);
    await expect(repo().find('storify', 7)).resolves.toEqual({
      ...pull(7),
      projectSlug: 'storify',
      provider: 'github',
      itemId: null,
      ciState: 'unknown',
      ciStale: true,
      syncedAt: SYNCED,
    });
    await expect(repo().find('storify', 8)).resolves.toBeNull();
    await expect(repo().find('legacy', 7)).resolves.toBeNull();
  });

  it('keeps the newer provider change when an older one arrives later', async () => {
    await repo().upsert('storify', pull(7, { title: 'new', updatedAt: '2026-11-09T11:00:00.000Z' }), write);
    await expect(
      repo().upsert('storify', pull(7, { title: 'old', updatedAt: '2026-11-09T10:00:00.000Z' }), write),
    ).resolves.toBe(false);
    expect((await repo().find('storify', 7))?.title).toBe('new');
    await repo().upsert(
      'storify',
      pull(7, { state: 'merged', updatedAt: '2026-11-09T12:00:00.000Z' }),
      write,
    );
    expect((await repo().find('storify', 7))?.state).toBe('merged');
  });

  it('lets the later write win a same-second tie, the accepted limit of a 1-second updated_at (#481)', async () => {
    const second = '2026-11-09T11:00:00.000Z';
    await repo().upsert('storify', pull(7, { title: 'first', updatedAt: second }), write);
    await expect(
      repo().upsert('storify', pull(7, { title: 'second', headSha: NEXT_HEAD, updatedAt: second }), write),
    ).resolves.toBe(true);
    expect(await repo().find('storify', 7)).toMatchObject({ title: 'second', headSha: NEXT_HEAD });
    // A late arrival of the same second wins too; the next change (a later second) corrects it.
    await repo().upsert('storify', pull(7, { title: 'first', updatedAt: second }), write);
    expect((await repo().find('storify', 7))?.title).toBe('first');
    await repo().upsert(
      'storify',
      pull(7, { title: 'third', headSha: NEXT_HEAD, updatedAt: '2026-11-09T11:00:01.000Z' }),
      write,
    );
    await expect(
      repo().upsert('storify', pull(7, { title: 'first', updatedAt: second }), write),
    ).resolves.toBe(false);
    expect(await repo().find('storify', 7)).toMatchObject({ title: 'third', headSha: NEXT_HEAD });
  });

  it('keeps CI while the head stays, resets it to unknown + stale when the head moves', async () => {
    await repo().upsert('storify', pull(7), { ...write, ci: 'success' });
    expect(await repo().find('storify', 7)).toMatchObject({ ciState: 'success', ciStale: false });
    await repo().upsert(
      'storify',
      pull(7, { title: 'renamed', updatedAt: '2026-11-09T10:05:00.000Z' }),
      write,
    );
    expect(await repo().find('storify', 7)).toMatchObject({ ciState: 'success', ciStale: false });
    await repo().upsert(
      'storify',
      pull(7, { headSha: NEXT_HEAD, updatedAt: '2026-11-09T10:10:00.000Z' }),
      write,
    );
    expect(await repo().find('storify', 7)).toMatchObject({
      headSha: NEXT_HEAD,
      ciState: 'unknown',
      ciStale: true,
    });
    await repo().upsert('storify', pull(7, { headSha: NEXT_HEAD, updatedAt: '2026-11-09T10:10:00.000Z' }), {
      ...write,
      ci: 'pending',
    });
    expect(await repo().find('storify', 7)).toMatchObject({ ciState: 'pending', ciStale: false });
  });

  it('writes nothing for an archived or unknown project, or a delivery of another repository id', async () => {
    await expect(repo().upsert('gone', pull(1), write)).resolves.toBe(false);
    await expect(repo().upsert('nope', pull(1), write)).resolves.toBe(false);
    await expect(repo().upsert('storify', pull(1), { ...write, repositoryId: 999 })).resolves.toBe(false);
    await expect(repo().upsert('storify', pull(1), { ...write, repositoryId: 860001 })).resolves.toBe(true);
    // T-2 (#466), fail closed: a project without a recorded repository id takes no row from any delivery or read —
    // the api Worker backfills the id first (`ensureRepoId`), the hooks Worker from a matching delivery.
    await expect(repo().upsert('legacy', pull(1), { ...write, repositoryId: 999 })).resolves.toBe(false);
    await expect(repo().markCiStale('legacy', HEAD, 999)).resolves.toBe(0);
    const { results } = await env.DB.prepare(
      'SELECT project_slug FROM pull_requests ORDER BY project_slug',
    ).all();
    expect(results).toEqual([{ project_slug: 'storify' }]);
  });

  it('sets CI only for the head it was read for', async () => {
    await repo().upsert('storify', pull(7), write);
    await expect(repo().setCi('storify', 7, NEXT_HEAD, 'failure', SYNCED)).resolves.toBe(false);
    await expect(repo().setCi('storify', 7, HEAD, 'failure', SYNCED)).resolves.toBe(true);
    expect(await repo().find('storify', 7)).toMatchObject({ ciState: 'failure', ciStale: false });
  });

  it('marks the open pull requests of a finished head stale, never a closed one or another repository', async () => {
    await repo().upsert('storify', pull(7), { ...write, ci: 'pending' });
    await repo().upsert('storify', pull(8, { state: 'closed' }), { ...write, ci: 'pending' });
    await repo().upsert('storify', pull(9, { headSha: NEXT_HEAD }), { ...write, ci: 'pending' });
    await expect(repo().markCiStale('storify', HEAD, 999)).resolves.toBe(0);
    await expect(repo().markCiStale('storify', HEAD, 860001)).resolves.toBe(1);
    expect(await repo().find('storify', 7)).toMatchObject({ ciState: 'pending', ciStale: true });
    expect(await repo().find('storify', 8)).toMatchObject({ ciStale: false });
    expect(await repo().find('storify', 9)).toMatchObject({ ciStale: false });
  });

  it('lists in number order after a cursor, by state, with the next cursor', async () => {
    for (const number of [3, 1, 2, 5]) {
      await repo().upsert('storify', pull(number, number === 5 ? { state: 'merged' } : {}), write);
    }
    await repo().upsert('legacy', pull(4), write);
    const first = await repo().list('storify', {}, 0, 2);
    expect(first.items.map((row) => row.number)).toEqual([1, 2]);
    expect(first.next).toBe(2);
    const rest = await repo().list('storify', {}, 2, 2);
    expect(rest.items.map((row) => row.number)).toEqual([3, 5]);
    expect(rest.next).toBeNull();
    expect((await repo().list('storify', { state: 'merged' }, 0, 10)).items.map((row) => row.number)).toEqual(
      [5],
    );
    await expect(repo().openNumbers('storify')).resolves.toEqual([3, 2, 1]);
  });

  it('refuses a row the schema forbids (a short sha, a non-https url)', async () => {
    await expect(repo().upsert('storify', pull(1, { headSha: 'abc' }), write)).rejects.toThrow();
    await expect(repo().upsert('storify', pull(1, { url: 'javascript:alert(1)' }), write)).rejects.toThrow();
  });
});
