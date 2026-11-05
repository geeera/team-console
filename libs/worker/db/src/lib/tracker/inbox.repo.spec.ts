import { env } from 'cloudflare:test';
import { AT, JOB_ACTOR, seedTrackerItem, seedTrackerProject } from '../../testing/tracker-kit';
import { AsksRepo } from './asks.repo';
import { INBOX_ROW_CAP, InboxRepo } from './inbox.repo';
import { ItemsRepo } from './items.repo';

async function ask(slug: string, itemId: number, source: 'console' | 'import' = 'console'): Promise<void> {
  if (source === 'console') {
    await env.DB.batch(
      new AsksRepo(env.DB).createStatements(
        slug,
        itemId,
        {
          category: 'money',
          ask: 'Pay for the domain?',
          commands: ['approve', 'reject'],
          recommended: 'reject',
        },
        JOB_ACTOR,
        AT,
        null,
      ),
    );
    return;
  }
  await env.DB.prepare(
    `INSERT INTO asks (project_slug, item_id, category, ask, commands, created_at, source)
     VALUES (?1, ?2, 'scope', 'Imported?', '["approve","reject"]', ?3, 'import')`,
  )
    .bind(slug, itemId, AT)
    .run();
}

describe('InboxRepo', () => {
  it('lists the open items that can classify, in number order, with their open console ask', async () => {
    const { slug } = await seedTrackerProject();
    const question = await seedTrackerItem(slug, 1, { kind: 'question' });
    await seedTrackerItem(slug, 2, { kind: 'feature', status: 'approved' });
    await seedTrackerItem(slug, 3, { kind: 'chore', status: 'blocked', flags: ['needs:owner'] });
    await seedTrackerItem(slug, 4, { kind: 'feature', status: 'qa', flags: ['team:demo'] });
    await seedTrackerItem(slug, 5, { kind: 'feature', flags: ['design:awaiting-approval'] });
    await seedTrackerItem(slug, 6, { kind: 'chore', status: 'blocked', flags: ['needs:local'] });
    const closed = await seedTrackerItem(slug, 7, { kind: 'question' });
    const imported = await seedTrackerItem(slug, 8, { kind: 'question' });
    await ask(slug, question);
    await ask(slug, imported, 'import');
    const closedItem = await new ItemsRepo(env.DB).findByNumber(slug, 7);
    await new ItemsRepo(env.DB).update(
      closed,
      closedItem?.version ?? 1,
      { status: 'done', closedAt: AT, closedReason: 'done' },
      { add: [], remove: [] },
      JOB_ACTOR,
      [],
      AT,
    );

    const { rows, truncated } = await new InboxRepo(env.DB).listOpen(slug);
    expect(truncated).toBe(false);
    expect(rows.map((row) => [row.item.number, row.ask?.category ?? null])).toEqual([
      [1, 'money'],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
      // The imported ask is never joined (R7): the item is listed without it.
      [8, null],
    ]);
    expect(rows[0]?.ask).toMatchObject({
      commands: ['approve', 'reject'],
      recommended: 'reject',
      source: 'console',
    });
    expect(rows[1]?.item.flags).toEqual(['needs:owner']);
  });

  it('reads one project only', async () => {
    const { slug } = await seedTrackerProject();
    const { slug: other } = await seedTrackerProject();
    await seedTrackerItem(other, 1, { kind: 'question' });
    expect((await new InboxRepo(env.DB).listOpen(slug)).rows).toEqual([]);
  });

  it(`stops at ${String(INBOX_ROW_CAP)} rows and says so`, async () => {
    const { slug } = await seedTrackerProject();
    const statements = Array.from({ length: INBOX_ROW_CAP + 1 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO items (project_slug, number, kind, status, title, created_by_kind, created_by, created_at,
           updated_at)
         VALUES (?1, ?2, 'question', 'proposed', 'Q', 'owner', 'owner', ?3, ?3)`,
      ).bind(slug, index + 1, AT),
    );
    await env.DB.batch(statements);
    const { rows, truncated } = await new InboxRepo(env.DB).listOpen(slug);
    expect(rows).toHaveLength(INBOX_ROW_CAP);
    expect(truncated).toBe(true);
    expect(rows.at(-1)?.item.number).toBe(INBOX_ROW_CAP);
  });
});
