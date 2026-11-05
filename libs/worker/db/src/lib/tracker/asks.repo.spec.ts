import { env } from 'cloudflare:test';
import { ASK_CATEGORIES, DECISION_COMMANDS } from '@shared/contracts';
import { ANSWERABLE, OWNER_CATEGORIES } from '@shared/owner-grammar';
import {
  AT,
  JOB_ACTOR,
  seedGitHubProject,
  seedTrackerItem,
  seedTrackerProject,
} from '../../testing/tracker-kit';
import { AsksRepo, type NewAsk } from './asks.repo';
import { ItemEventsRepo } from './item-events.repo';

const asks = (): AsksRepo => new AsksRepo(env.DB);

const ASK: NewAsk = {
  category: 'scope',
  ask: 'Ship the export now or after the demo?',
  commands: ['approve', 'reject'],
  recommended: 'approve',
};

async function seed(): Promise<{ slug: string; itemId: number }> {
  const { slug } = await seedTrackerProject();
  return { slug, itemId: await seedTrackerItem(slug, 1) };
}

async function insertAsk(slug: string, itemId: number, ask: NewAsk = ASK, replaced: number | null = null) {
  await env.DB.batch(asks().createStatements(slug, itemId, ask, JOB_ACTOR, AT, replaced));
}

function rawInsert(slug: string, itemId: number, commands: string, recommended: string | null = null) {
  return env.DB.prepare(
    `INSERT INTO asks (project_slug, item_id, category, ask, commands, recommended, created_at)
     VALUES (?1, ?2, 'scope', 'Q?', ?3, ?4, ?5)`,
  )
    .bind(slug, itemId, commands, recommended, AT)
    .run();
}

describe('AsksRepo', () => {
  it('creates an open ask with its asked event, and reads it back', async () => {
    const { slug, itemId } = await seed();
    await insertAsk(slug, itemId);
    const open = await asks().findOpen(itemId);
    expect(open).toMatchObject({
      itemId,
      category: 'scope',
      ask: ASK.ask,
      commands: ['approve', 'reject'],
      recommended: 'approve',
      jobId: 'job-test-1',
      source: 'console',
      answeredByDecisionId: null,
      withdrawnAt: null,
    });
    expect(await asks().find(itemId, open?.id ?? 0)).toEqual(open);
    const events = await new ItemEventsRepo(env.DB).list(itemId, 0, 10);
    expect(
      events.filter((event) => event.kind === 'asked').map((event) => [event.actorKind, event.after]),
    ).toEqual([['job', { askId: open?.id, replacedAskId: null, category: 'scope' }]]);
  });

  it('allows one open ask per item: a second throws unless the first is withdrawn in the same batch', async () => {
    const { slug, itemId } = await seed();
    await insertAsk(slug, itemId);
    const first = await asks().findOpen(itemId);
    await expect(insertAsk(slug, itemId)).rejects.toThrow(/append-only/);

    await env.DB.batch([
      asks().withdrawStatement(first?.id ?? 0, AT),
      ...asks().createStatements(
        slug,
        itemId,
        { ...ASK, category: 'money' },
        JOB_ACTOR,
        AT,
        first?.id ?? null,
      ),
    ]);
    const second = await asks().findOpen(itemId);
    expect(second).toMatchObject({ category: 'money' });
    expect(await asks().find(itemId, first?.id ?? 0)).toMatchObject({ withdrawnAt: AT });
    expect((await asks().list(itemId, 0, 10)).map((ask) => ask.id)).toEqual([first?.id, second?.id]);
    expect(await asks().list(itemId, first?.id ?? 0, 10)).toHaveLength(1);
  });

  it('is append-only: no edit, no delete, no replace, and the withdrawal and the answer are set once', async () => {
    const { slug, itemId } = await seed();
    await insertAsk(slug, itemId);
    const id = (await asks().findOpen(itemId))?.id ?? 0;
    await expect(
      env.DB.prepare("UPDATE asks SET ask = 'edited' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM asks WHERE id = ?1').bind(id).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO asks (id, project_slug, item_id, category, ask, commands, created_at)
         VALUES (?1, ?2, ?3, 'money', 'replaced', '["done"]', ?4)`,
      )
        .bind(id, slug, itemId, AT)
        .run(),
    ).rejects.toThrow(/append-only/);
    // REPLACE through the partial unique index (a fresh id, the same open item) is refused too.
    await expect(
      env.DB.prepare(
        `REPLACE INTO asks (project_slug, item_id, category, ask, commands, created_at)
         VALUES (?1, ?2, 'money', 'replaced', '["done"]', ?3)`,
      )
        .bind(slug, itemId, AT)
        .run(),
    ).rejects.toThrow(/append-only/);

    await env.DB.batch([asks().withdrawStatement(id, AT)]);
    await expect(env.DB.batch([asks().withdrawStatement(id, '2026-11-05T00:00:00.000Z')])).rejects.toThrow(
      /append-only/,
    );
    // A withdrawn ask is never answered (the CHECK keeps the two apart).
    await expect(
      env.DB.prepare('UPDATE asks SET answered_by_decision_id = 1 WHERE id = ?1').bind(id).run(),
    ).rejects.toThrow(/CHECK|FOREIGN KEY/);
  });

  it('refuses commands outside ANSWERABLE, duplicates, an empty list and a recommendation outside them', async () => {
    const { slug, itemId } = await seed();
    for (const [commands, recommended] of [
      ['["approve","resume"]', null],
      ['["approve","approve"]', null],
      ['[]', null],
      ['[1]', null],
      ['["go","no-go"]', 'approve'],
    ] as const) {
      await expect(rawInsert(slug, itemId, commands, recommended)).rejects.toThrow(/ANSWERABLE/);
    }
    await expect(rawInsert(slug, itemId, '{"a":1}')).rejects.toThrow(/CHECK|ANSWERABLE/);
    await expect(rawInsert(slug, itemId, 'not json')).rejects.toThrow(/CHECK|JSON/);
    await expect(rawInsert(slug, itemId, '["go","no-go","override"]', 'go')).resolves.toBeDefined();
  });

  it('never points at an item of another project', async () => {
    const { itemId } = await seed();
    const other = await seedGitHubProject();
    await expect(rawInsert(other, itemId, '["done"]')).rejects.toThrow(/FOREIGN KEY/);
  });
});

// @shared/contracts cannot import the grammar, and 0014's CHECKs spell the same lists: all three must agree.
describe('the ask vocabulary agrees with the plugin grammar', () => {
  it('asks categories are the plugin owner categories', () => {
    expect([...ASK_CATEGORIES]).toEqual([...OWNER_CATEGORIES]);
  });

  it('decision commands are ANSWERABLE plus resume', () => {
    expect(DECISION_COMMANDS.filter((command) => command !== 'resume').sort()).toEqual([...ANSWERABLE]);
  });
});
