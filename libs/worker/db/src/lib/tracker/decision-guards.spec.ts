import { env } from 'cloudflare:test';
import { AT, JOB_ACTOR, OWNER_ACTOR, seedTrackerItem, seedTrackerProject } from '../../testing/tracker-kit';
import { CommentsRepo } from './comments.repo';
import { isAppendOnlyConflict } from './constraint-error';
import { OwnerDecisionsRepo } from './owner-decisions.repo';

// #443 (security review of #440, findings 1-4): migration 0015's cross-row guards, attacked with raw SQL as a buggy
// repo or a later writer would. The repos never write these rows this way; the schema refuses them anyway.

let keyCounter = 0;

async function item(): Promise<{ slug: string; itemId: number }> {
  const { slug } = await seedTrackerProject();
  return { slug, itemId: await seedTrackerItem(slug, 1) };
}

async function insertAsk(
  slug: string,
  itemId: number,
  source: 'console' | 'import' = 'console',
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO asks (project_slug, item_id, category, ask, commands, created_at, source)
     VALUES (?1, ?2, 'scope', 'Q?', '["approve","reject"]', ?3, ?4) RETURNING id`,
  )
    .bind(slug, itemId, AT, source)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function insertDecision(
  slug: string,
  itemId: number,
  options: { askId?: number | null; reversesCommentId?: number | null; via?: 'web' | 'push' | 'import' } = {},
): Promise<number> {
  keyCounter += 1;
  const via = options.via ?? 'web';
  const row = await env.DB.prepare(
    `INSERT INTO owner_decisions (project_slug, item_id, ask_id, command, text, decided_at, via, idempotency_key,
       reverses_comment_id)
     VALUES (?1, ?2, ?3, 'reject', 'No', ?4, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(
      slug,
      itemId,
      options.askId ?? null,
      AT,
      via,
      via === 'import' ? null : `key-guard-${String(keyCounter)}`,
      options.reversesCommentId ?? null,
    )
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function answer(askId: number, decisionId: number): Promise<unknown> {
  return env.DB.prepare('UPDATE asks SET answered_by_decision_id = ?2 WHERE id = ?1')
    .bind(askId, decisionId)
    .run();
}

async function teamDecision(itemId: number, kind: 'decision' | 'comment' = 'decision'): Promise<number> {
  return new CommentsRepo(env.DB).create(itemId, { kind, body: 'We ship without the export' }, JOB_ACTOR, AT);
}

async function reverse(commentId: number, decisionId: number): Promise<unknown> {
  return env.DB.prepare('UPDATE comments SET reversed_by_decision_id = ?2 WHERE id = ?1')
    .bind(commentId, decisionId)
    .run();
}

/** The guard refused it, and with a message the routes never mistake for a lost race. */
async function expectGuard(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  let failure: unknown = null;
  try {
    await run();
  } catch (error: unknown) {
    failure = error;
  }
  expect(String(failure)).toMatch(message);
  expect(isAppendOnlyConflict(failure)).toBe(false);
}

async function answeredBy(askId: number): Promise<number | null> {
  const row = await env.DB.prepare('SELECT answered_by_decision_id AS id FROM asks WHERE id = ?1')
    .bind(askId)
    .first<{ id: number | null }>();
  return row?.id ?? null;
}

describe('asks.answered_by_decision_id (0015)', () => {
  const GUARD = /asks\.answered_by_decision_id must be a decision on this ask/;

  it('refuses a decision on an item of another project', async () => {
    const a = await item();
    const b = await item();
    const askId = await insertAsk(a.slug, a.itemId);
    const elsewhere = await insertDecision(b.slug, b.itemId);
    await expectGuard(async () => answer(askId, elsewhere), GUARD);
    expect(await answeredBy(askId)).toBeNull();
  });

  it('refuses a decision on the same item that does not name the ask', async () => {
    const { slug, itemId } = await item();
    const askId = await insertAsk(slug, itemId);
    const unbound = await insertDecision(slug, itemId);
    await expectGuard(async () => answer(askId, unbound), GUARD);
  });

  it('refuses an ask inserted already answered', async () => {
    const { slug, itemId } = await item();
    const decisionId = await insertDecision(slug, itemId);
    await expectGuard(
      async () =>
        env.DB.prepare(
          `INSERT INTO asks (project_slug, item_id, category, ask, commands, created_at, answered_by_decision_id)
           VALUES (?1, ?2, 'scope', 'Q?', '["approve"]', ?3, ?4)`,
        )
          .bind(slug, itemId, AT, decisionId)
          .run(),
      GUARD,
    );
  });

  it('accepts the decision that names the ask, as the repo writes it', async () => {
    const { slug, itemId } = await item();
    const askId = await insertAsk(slug, itemId);
    await env.DB.batch(
      new OwnerDecisionsRepo(env.DB).createStatements(
        slug,
        itemId,
        {
          command: 'approve',
          text: '',
          askId,
          reversesCommentId: null,
          via: 'web',
          idempotencyKey: 'key-guard-ok',
        },
        OWNER_ACTOR,
        AT,
      ),
    );
    expect(await answeredBy(askId)).not.toBeNull();
  });
});

describe('R7 in the schema (0015)', () => {
  it('a web or push decision never names an imported ask', async () => {
    const { slug, itemId } = await item();
    const imported = await insertAsk(slug, itemId, 'import');
    for (const via of ['web', 'push'] as const) {
      await expectGuard(
        async () => insertDecision(slug, itemId, { askId: imported, via }),
        /owner_decisions\.ask_id must be an ask of this item of the same source/,
      );
    }
  });

  it('a web decision never answers an imported ask, even one it does not name', async () => {
    const { slug, itemId } = await item();
    const imported = await insertAsk(slug, itemId, 'import');
    const web = await insertDecision(slug, itemId);
    await expectGuard(async () => answer(imported, web), /asks\.answered_by_decision_id must be/);
    expect(await answeredBy(imported)).toBeNull();
  });

  it('an imported decision answers an imported ask, never a console one', async () => {
    const { slug, itemId } = await item();
    const imported = await insertAsk(slug, itemId, 'import');
    const history = await insertDecision(slug, itemId, { askId: imported, via: 'import' });
    await answer(imported, history);
    expect(await answeredBy(imported)).toBe(history);

    const other = await item();
    const consoleAsk = await insertAsk(other.slug, other.itemId);
    await expectGuard(
      async () => insertDecision(other.slug, other.itemId, { askId: consoleAsk, via: 'import' }),
      /owner_decisions\.ask_id must be an ask of this item of the same source/,
    );
  });
});

describe('reversing a team decision (0015)', () => {
  it('a decision never reverses a comment of another item or project', async () => {
    const a = await item();
    const b = await item();
    const commentId = await teamDecision(b.itemId);
    await expectGuard(
      async () => insertDecision(a.slug, a.itemId, { reversesCommentId: commentId }),
      /owner_decisions\.reverses_comment_id must be a team decision of this item/,
    );
  });

  it('a decision never reverses a plain comment', async () => {
    const { slug, itemId } = await item();
    const commentId = await teamDecision(itemId, 'comment');
    await expectGuard(
      async () => insertDecision(slug, itemId, { reversesCommentId: commentId }),
      /owner_decisions\.reverses_comment_id must be a team decision of this item/,
    );
  });

  it('a comment is marked reversed only by the decision on its item that reverses it', async () => {
    const a = await item();
    const b = await item();
    const commentId = await teamDecision(a.itemId);
    const GUARD = /comments\.reversed_by_decision_id must be a decision on this item reversing this comment/;
    await expectGuard(async () => reverse(commentId, await insertDecision(b.slug, b.itemId)), GUARD);
    await expectGuard(async () => reverse(commentId, await insertDecision(a.slug, a.itemId)), GUARD);
    const reversing = await insertDecision(a.slug, a.itemId, { reversesCommentId: commentId });
    await reverse(commentId, reversing);
    const row = await env.DB.prepare('SELECT reversed_by_decision_id AS id FROM comments WHERE id = ?1')
      .bind(commentId)
      .first<{ id: number | null }>();
    expect(row?.id).toBe(reversing);
  });

  it('a comment is never inserted already reversed', async () => {
    const { itemId } = await item();
    await expectGuard(
      async () =>
        env.DB.prepare(
          `INSERT INTO comments (item_id, kind, author_kind, author, body, created_at, reversed_by_decision_id)
           VALUES (?1, 'decision', 'job', 'architect', 'Body', ?2, 1)`,
        )
          .bind(itemId, AT)
          .run(),
      /comments\.reversed_by_decision_id must be/,
    );
  });
});

describe('import_map (0015)', () => {
  const MAP = `INSERT INTO import_map (project_slug, source_kind, source_id, target_table, target_id)
               VALUES (?1, 'issue', '42', 'items', ?2)`;
  const GUARD = /import_map rows are never re-pointed/;

  async function targets(slug: string): Promise<string[]> {
    const { results } = await env.DB.prepare('SELECT target_id FROM import_map WHERE project_slug = ?1')
      .bind(slug)
      .all<{ target_id: string }>();
    return results.map((row) => row.target_id);
  }

  it('skips the same mapping inserted again, so an import re-run is idempotent', async () => {
    const { slug } = await seedTrackerProject();
    await env.DB.prepare(MAP).bind(slug, '7').run();
    await env.DB.prepare(MAP).bind(slug, '7').run();
    await env.DB.prepare(MAP.replace('INSERT', 'INSERT OR REPLACE')).bind(slug, '7').run();
    expect(await targets(slug)).toEqual(['7']);
  });

  it('never re-points a mapping: another target, REPLACE, UPDATE and DELETE are refused', async () => {
    const { slug } = await seedTrackerProject();
    await env.DB.prepare(MAP).bind(slug, '7').run();
    await expectGuard(async () => env.DB.prepare(MAP).bind(slug, '8').run(), GUARD);
    await expectGuard(
      async () => env.DB.prepare(MAP.replace('INSERT', 'INSERT OR REPLACE')).bind(slug, '8').run(),
      GUARD,
    );
    await expectGuard(
      async () => env.DB.prepare(MAP.replace('INSERT', 'REPLACE')).bind(slug, '8').run(),
      GUARD,
    );
    await expectGuard(
      async () =>
        env.DB.prepare("UPDATE import_map SET target_id = '8' WHERE project_slug = ?1").bind(slug).run(),
      GUARD,
    );
    await expectGuard(
      async () => env.DB.prepare('DELETE FROM import_map WHERE project_slug = ?1').bind(slug).run(),
      GUARD,
    );
    expect(await targets(slug)).toEqual(['7']);
  });
});
