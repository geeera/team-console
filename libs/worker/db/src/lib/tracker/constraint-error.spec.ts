import { env } from 'cloudflare:test';
import { AT, JOB_ACTOR, OWNER_ACTOR, seedTrackerItem, seedTrackerProject } from '../../testing/tracker-kit';
import { AsksRepo } from './asks.repo';
import { batchUnlessConflict, isAppendOnlyConflict } from './constraint-error';
import { OwnerDecisionsRepo } from './owner-decisions.repo';

// #443 (security review of #441, finding 2): only a lost race is retried into 409 `item-changed`; any other
// constraint failure is a bug and must surface.

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the batch to fail');
}

async function seedWithAsk(): Promise<{ slug: string; itemId: number; askId: number }> {
  const { slug } = await seedTrackerProject();
  const itemId = await seedTrackerItem(slug, 1);
  const asks = new AsksRepo(env.DB);
  await env.DB.batch(
    asks.createStatements(
      slug,
      itemId,
      { category: 'scope', ask: 'Q?', commands: ['approve', 'reject'], recommended: null },
      JOB_ACTOR,
      AT,
      null,
    ),
  );
  return { slug, itemId, askId: (await asks.findOpen(itemId))?.id ?? 0 };
}

function decisionStatements(
  slug: string,
  itemId: number,
  askId: number | null,
  key: string,
): D1PreparedStatement[] {
  return new OwnerDecisionsRepo(env.DB).createStatements(
    slug,
    itemId,
    { command: 'approve', text: '', askId, reversesCommentId: null, via: 'web', idempotencyKey: key },
    OWNER_ACTOR,
    AT,
  );
}

describe('isAppendOnlyConflict', () => {
  it('is a lost race when a trigger refuses a second answer', async () => {
    const { slug, itemId, askId } = await seedWithAsk();
    await env.DB.batch(decisionStatements(slug, itemId, askId, 'key-race-1'));
    const error = await failureOf(async () =>
      env.DB.batch(decisionStatements(slug, itemId, askId, 'key-race-2')),
    );
    expect(isAppendOnlyConflict(error)).toBe(true);
  });

  it('is a lost race when the asks CHECK refuses answering a withdrawn ask', async () => {
    const { slug, itemId, askId } = await seedWithAsk();
    await env.DB.batch([new AsksRepo(env.DB).withdrawStatement(askId, AT)]);
    const error = await failureOf(async () =>
      env.DB.batch(decisionStatements(slug, itemId, askId, 'key-race-3')),
    );
    expect(isAppendOnlyConflict(error)).toBe(true);
    expect(await batchUnlessConflict(env.DB, decisionStatements(slug, itemId, askId, 'key-race-4'))).toBe(
      false,
    );
  });

  it('is not a lost race when any other CHECK fails: batchUnlessConflict rethrows it', async () => {
    const { slug, itemId } = await seedWithAsk();
    const tooLong = env.DB.prepare(
      `INSERT INTO owner_decisions (project_slug, item_id, command, text, decided_at, via, idempotency_key)
       VALUES (?1, ?2, 'approve', ?3, ?4, 'web', 'key-check-1')`,
    ).bind(slug, itemId, 'x'.repeat(2001), AT);
    const error = await failureOf(async () => env.DB.batch([tooLong]));
    expect(String(error)).toMatch(/CHECK constraint failed/);
    expect(isAppendOnlyConflict(error)).toBe(false);
    await expect(batchUnlessConflict(env.DB, [tooLong])).rejects.toThrow(/CHECK constraint failed/);
  });

  it.each([
    'D1_ERROR: CHECK constraint failed: length(text) <= 2000: SQLITE_CONSTRAINT',
    "D1_ERROR: CHECK constraint failed: via = 'import' OR idempotency_key IS NOT NULL",
    'D1_ERROR: NOT NULL constraint failed: items.version',
    'D1_ERROR: asks.answered_by_decision_id must be a decision on this ask of the same source',
  ])('is not a lost race: %s', (message) => {
    expect(isAppendOnlyConflict(new Error(message))).toBe(false);
    expect(isAppendOnlyConflict(new Error('D1_ERROR', { cause: new Error(message) }))).toBe(false);
  });

  it('reads the cause as well as the message', () => {
    const race = 'CHECK constraint failed: answered_by_decision_id IS NULL OR withdrawn_at IS NULL';
    expect(isAppendOnlyConflict(new Error('D1_ERROR', { cause: new Error(race) }))).toBe(true);
    expect(isAppendOnlyConflict(new Error('asks are append-only'))).toBe(true);
    expect(isAppendOnlyConflict('asks are append-only')).toBe(false);
  });
});
