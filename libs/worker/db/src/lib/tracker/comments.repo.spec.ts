import { env } from 'cloudflare:test';
import { AT, OWNER_ACTOR, seedTrackerProject } from '../../testing/tracker-kit';
import { CommentsRepo } from './comments.repo';
import { IdempotencyKeysRepo } from './idempotency-keys.repo';
import { ItemEventsRepo } from './item-events.repo';
import { ItemsRepo } from './items.repo';

const comments = (): CommentsRepo => new CommentsRepo(env.DB);

async function seedItem(): Promise<number> {
  const { slug } = await seedTrackerProject();
  await new ItemsRepo(env.DB).create(
    slug,
    {
      number: 1,
      kind: 'chore',
      status: 'approved',
      severity: null,
      tier: null,
      sprint: null,
      title: 'Item',
      body: '',
      flags: [],
    },
    OWNER_ACTOR,
    AT,
  );
  const item = await new ItemsRepo(env.DB).findByNumber(slug, 1);
  return item?.id ?? 0;
}

describe('CommentsRepo', () => {
  it('appends comments oldest first, each with a commented event naming it', async () => {
    const itemId = await seedItem();
    const first = await comments().create(itemId, { kind: 'comment', body: 'one' }, OWNER_ACTOR, AT);
    const second = await comments().create(itemId, { kind: 'comment', body: 'two' }, OWNER_ACTOR, AT);
    expect(second).toBeGreaterThan(first);
    const listed = await comments().list(itemId, 0, 10);
    expect(listed.map((row) => [row.id, row.body, row.authorKind, row.source])).toEqual([
      [first, 'one', 'owner', 'console'],
      [second, 'two', 'owner', 'console'],
    ]);
    await expect(comments().list(itemId, first, 10)).resolves.toHaveLength(1);
    const trail = await new ItemEventsRepo(env.DB).list(itemId, 0, 10);
    expect(trail.filter((row) => row.kind === 'commented').map((row) => row.after)).toEqual([
      { commentId: first, kind: 'comment' },
      { commentId: second, kind: 'comment' },
    ]);
  });

  it('completes an idempotency key with the new comment id in the same batch', async () => {
    const itemId = await seedItem();
    const keys = new IdempotencyKeysRepo(env.DB);
    const now = Date.parse(AT);
    expect(await keys.claim('key-comment-1', 'hash', now, 30_000)).toEqual({ state: 'claimed' });
    const id = await comments().create(itemId, { kind: 'comment', body: 'hi' }, OWNER_ACTOR, AT, [
      keys.completeStatement(
        'key-comment-1',
        'hash',
        { status: 201, kind: 'comment', ref: { newestCommentOf: itemId } },
        now + 1,
      ),
    ]);
    expect(await keys.claim('key-comment-1', 'hash', now, 30_000)).toEqual({
      state: 'done',
      status: 201,
      kind: 'comment',
      ref: String(id),
    });
  });

  it('can be neither edited nor deleted, and the reversal mark is set only once', async () => {
    const itemId = await seedItem();
    const id = await comments().create(itemId, { kind: 'comment', body: 'as typed' }, OWNER_ACTOR, AT);
    await expect(
      env.DB.prepare("UPDATE comments SET body = 'edited' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM comments WHERE id = ?1').bind(id).run()).rejects.toThrow(
      /append-only/,
    );
    await env.DB.prepare('UPDATE comments SET reversed_by_decision_id = 7 WHERE id = ?1').bind(id).run();
    await expect(
      env.DB.prepare('UPDATE comments SET reversed_by_decision_id = 8 WHERE id = ?1').bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(comments().find(itemId, id)).resolves.toMatchObject({
      body: 'as typed',
      reversedByDecisionId: 7,
    });
  });

  it('refuses INSERT OR REPLACE / REPLACE INTO over a comment, keeping plain inserts working', async () => {
    const itemId = await seedItem();
    const id = await comments().create(itemId, { kind: 'comment', body: 'as typed' }, OWNER_ACTOR, AT);
    for (const verb of ['INSERT OR REPLACE INTO', 'REPLACE INTO']) {
      await expect(
        env.DB.prepare(
          `${verb} comments (id, item_id, kind, author_kind, author, body, created_at) VALUES (?1, ?2, 'comment', 'owner', 'owner', 'rewritten', ?3)`,
        )
          .bind(id, itemId, AT)
          .run(),
      ).rejects.toThrow(/append-only/);
    }
    await expect(comments().find(itemId, id)).resolves.toMatchObject({ body: 'as typed' });
    await expect(comments().create(itemId, { kind: 'comment', body: 'next' }, OWNER_ACTOR, AT)).resolves.toBe(
      id + 1,
    );
  });

  it('refuses an empty body and an unknown kind', async () => {
    const itemId = await seedItem();
    await expect(comments().create(itemId, { kind: 'comment', body: '' }, OWNER_ACTOR, AT)).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      env.DB.prepare(
        "INSERT INTO comments (item_id, kind, author_kind, author, body, created_at) VALUES (?1, 'chat', 'owner', 'owner', 'x', ?2)",
      )
        .bind(itemId, AT)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('exposes no update or delete (append-only in the repo API too)', () => {
    const methods = Object.getOwnPropertyNames(CommentsRepo.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(['create', 'find', 'list']);
  });
});
