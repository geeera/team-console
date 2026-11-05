import { env } from 'cloudflare:test';
import { AT, JOB_ACTOR, OWNER_ACTOR, seedTrackerItem, seedTrackerProject } from '../../testing/tracker-kit';
import { AsksRepo } from './asks.repo';
import { CommentsRepo } from './comments.repo';
import { IdempotencyKeysRepo } from './idempotency-keys.repo';
import { ItemEventsRepo } from './item-events.repo';
import { ItemsRepo } from './items.repo';
import { OwnerDecisionsRepo, type NewDecision } from './owner-decisions.repo';

const decisions = (): OwnerDecisionsRepo => new OwnerDecisionsRepo(env.DB);

let keyCounter = 0;
function decision(overrides: Partial<NewDecision> = {}): NewDecision {
  keyCounter += 1;
  return {
    command: 'approve',
    text: '',
    askId: null,
    reversesCommentId: null,
    via: 'web',
    idempotencyKey: `key-decision-${String(keyCounter)}`,
    ...overrides,
  };
}

async function seedWithAsk(): Promise<{ slug: string; itemId: number; askId: number }> {
  const { slug } = await seedTrackerProject();
  const itemId = await seedTrackerItem(slug, 1);
  const repo = new AsksRepo(env.DB);
  await env.DB.batch(
    repo.createStatements(
      slug,
      itemId,
      { category: 'scope', ask: 'Q?', commands: ['approve', 'reject'], recommended: null },
      JOB_ACTOR,
      AT,
      null,
    ),
  );
  return { slug, itemId, askId: (await repo.findOpen(itemId))?.id ?? 0 };
}

describe('OwnerDecisionsRepo', () => {
  it('records a decision that answers its ask, with decided and answered events, in one batch', async () => {
    const { slug, itemId, askId } = await seedWithAsk();
    const keys = new IdempotencyKeysRepo(env.DB);
    const now = Date.parse(AT);
    await keys.claim('key-decide-1', 'hash', now, 30_000);
    await env.DB.batch([
      ...decisions().createStatements(
        slug,
        itemId,
        decision({ askId, idempotencyKey: 'key-decide-1' }),
        OWNER_ACTOR,
        AT,
      ),
      keys.completeStatement(
        'key-decide-1',
        'hash',
        { status: 201, kind: 'decision', ref: { newestDecisionOf: itemId } },
        now + 1,
      ),
    ]);
    const [recorded] = await decisions().list(itemId, 0, 10);
    expect(recorded).toMatchObject({
      itemId,
      askId,
      command: 'approve',
      via: 'web',
      idempotencyKey: 'key-decide-1',
    });
    expect(await decisions().find(itemId, recorded?.id ?? 0)).toEqual(recorded);
    expect(await new AsksRepo(env.DB).find(itemId, askId)).toMatchObject({
      answeredByDecisionId: recorded?.id,
    });
    expect(await new AsksRepo(env.DB).findOpen(itemId)).toBeNull();
    const events = await new ItemEventsRepo(env.DB).list(itemId, 0, 10);
    expect(
      events
        .filter((event) => event.kind === 'decided' || event.kind === 'answered')
        .map((e) => [e.kind, e.after]),
    ).toEqual([
      ['decided', { decisionId: recorded?.id, command: 'approve', askId }],
      ['answered', { askId, decisionId: recorded?.id }],
    ]);
    expect(await keys.claim('key-decide-1', 'hash', now, 30_000)).toMatchObject({
      state: 'done',
      kind: 'decision',
      ref: String(recorded?.id),
    });
  });

  it('fails the whole batch when its ask was answered or withdrawn since it was read', async () => {
    const { slug, itemId, askId } = await seedWithAsk();
    await env.DB.batch(decisions().createStatements(slug, itemId, decision({ askId }), OWNER_ACTOR, AT));
    await expect(
      env.DB.batch(decisions().createStatements(slug, itemId, decision({ askId }), OWNER_ACTOR, AT)),
    ).rejects.toThrow(/append-only/);
    expect(await decisions().list(itemId, 0, 10)).toHaveLength(1);

    const other = await seedWithAsk();
    await env.DB.batch([new AsksRepo(env.DB).withdrawStatement(other.askId, AT)]);
    await expect(
      env.DB.batch(
        decisions().createStatements(
          other.slug,
          other.itemId,
          decision({ askId: other.askId }),
          OWNER_ACTOR,
          AT,
        ),
      ),
    ).rejects.toThrow(/CHECK/);
    expect(await decisions().list(other.itemId, 0, 10)).toEqual([]);
  });

  it('reverses a team decision comment once', async () => {
    const { slug } = await seedTrackerProject();
    const itemId = await seedTrackerItem(slug, 1);
    const commentId = await new CommentsRepo(env.DB).create(
      itemId,
      { kind: 'decision', body: 'We ship without export' },
      JOB_ACTOR,
      AT,
    );
    await env.DB.batch(
      decisions().createStatements(
        slug,
        itemId,
        decision({ command: 'reject', text: 'Export first', reversesCommentId: commentId }),
        OWNER_ACTOR,
        AT,
      ),
    );
    const [recorded] = await decisions().list(itemId, 0, 10);
    expect(await new CommentsRepo(env.DB).find(itemId, commentId)).toMatchObject({
      reversedByDecisionId: recorded?.id,
    });
    await expect(
      env.DB.batch(
        decisions().createStatements(
          slug,
          itemId,
          decision({ command: 'reject', text: 'again', reversesCommentId: commentId }),
          OWNER_ACTOR,
          AT,
        ),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('is fully append-only: no update, no delete, no replace', async () => {
    const { slug, itemId } = await seedWithAsk();
    await env.DB.batch(decisions().createStatements(slug, itemId, decision(), OWNER_ACTOR, AT));
    const [recorded] = await decisions().list(itemId, 0, 10);
    const id = recorded?.id ?? 0;
    await expect(
      env.DB.prepare("UPDATE owner_decisions SET command = 'reject' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM owner_decisions WHERE id = ?1').bind(id).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO owner_decisions (id, project_slug, item_id, command, decided_at, via, idempotency_key)
         VALUES (?1, ?2, ?3, 'reject', ?4, 'web', 'other-key')`,
      )
        .bind(id, slug, itemId, AT)
        .run(),
    ).rejects.toThrow(/append-only/);
    // Replacing through the unique idempotency key is refused as well.
    await expect(
      env.DB.prepare(
        `REPLACE INTO owner_decisions (project_slug, item_id, command, decided_at, via, idempotency_key)
         VALUES (?1, ?2, 'reject', ?3, 'web', ?4)`,
      )
        .bind(slug, itemId, AT, recorded?.idempotencyKey ?? '')
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a route decision without a key, a source_url outside an import, and an unknown command or via', async () => {
    const { slug, itemId } = await seedWithAsk();
    const insert = (command: string, via: string, key: string | null, sourceUrl: string | null = null) =>
      env.DB.prepare(
        `INSERT INTO owner_decisions (project_slug, item_id, command, decided_at, via, idempotency_key, source_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(slug, itemId, command, AT, via, key, sourceUrl)
        .run();
    await expect(insert('approve', 'web', null)).rejects.toThrow(/CHECK/);
    await expect(insert('approve', 'push', 'k-1', 'https://github.com/x')).rejects.toThrow(/CHECK/);
    await expect(insert('merge', 'web', 'k-2')).rejects.toThrow(/CHECK/);
    await expect(insert('approve', 'job', 'k-3')).rejects.toThrow(/CHECK/);
    await expect(insert('resume', 'web', 'k-4')).resolves.toBeDefined();
  });

  it('never answers an ask on another item', async () => {
    const { slug, askId } = await seedWithAsk();
    const otherItem = await seedTrackerItem(slug, 2);
    await expect(
      env.DB.batch(decisions().createStatements(slug, otherItem, decision({ askId }), OWNER_ACTOR, AT)),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  // R7: an imported decision is history. Nothing derives effects from a row, so it changes no item, answers no ask,
  // and is listed like any other decision.
  it('lists an imported decision as history; it changes no item and answers no ask', async () => {
    const { slug, itemId, askId } = await seedWithAsk();
    const before = await new ItemsRepo(env.DB).findByNumber(slug, 1);
    await env.DB.prepare(
      `INSERT INTO owner_decisions (project_slug, item_id, ask_id, command, text, decided_at, via, idempotency_key,
         source_url)
       VALUES (?1, ?2, NULL, 'approve', '', ?3, 'import', NULL, 'https://github.com/acme/x/issues/1#c1')`,
    )
      .bind(slug, itemId, AT)
      .run();
    expect(await new ItemsRepo(env.DB).findByNumber(slug, 1)).toEqual(before);
    expect(await new AsksRepo(env.DB).findOpen(itemId)).toMatchObject({
      id: askId,
      answeredByDecisionId: null,
    });
    expect(await decisions().list(itemId, 0, 10)).toEqual([
      expect.objectContaining({
        via: 'import',
        idempotencyKey: null,
        sourceUrl: expect.any(String) as unknown,
      }),
    ]);
  });
});
