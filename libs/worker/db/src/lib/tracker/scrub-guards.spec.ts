import { env } from 'cloudflare:test';
import { AT, JOB_ACTOR, OWNER_ACTOR, seedTrackerItem, seedTrackerProject } from '../../testing/tracker-kit';
import { AsksRepo } from './asks.repo';
import { CommentsRepo } from './comments.repo';
import { ItemEventsRepo, SCRUBBED_TEXT, scrubIdsMissing } from './item-events.repo';
import { ItemRequestsRepo } from './item-requests.repo';
import { SprintsRepo } from './sprints.repo';

// #477 (migration 0043): the owner's scrub reaches comments, asks, request reasons, `imported` events and a sprint's
// text. These specs prove the other half of the criterion: the marker in the text column is the only update the
// append-only tables admit, column by column, with the column list read from the schema so a column added later
// fails here until it is decided.

type GuardedTable = 'comments' | 'asks' | 'item_requests' | 'item_events';
type Row = Record<string, unknown>;

const LATER = '2030-01-01T00:00:00.000Z';
const APPEND_ONLY = /append-only/;

async function columnsOf(table: GuardedTable): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT name FROM pragma_table_info(?1) ORDER BY name')
    .bind(table)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

async function rowOf(table: GuardedTable, id: number): Promise<Row> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(id).first<Row>();
  if (row === null) {
    throw new Error(`no ${table} row ${String(id)}`);
  }
  return row;
}

interface Seeded {
  readonly slug: string;
  readonly itemId: number;
}

async function seed(): Promise<Seeded> {
  const { slug } = await seedTrackerProject();
  return { slug, itemId: await seedTrackerItem(slug, 1) };
}

async function seedComment({ itemId }: Seeded, body = 'the token was pasted here'): Promise<number> {
  return new CommentsRepo(env.DB).create(itemId, { kind: 'comment', body }, JOB_ACTOR, AT);
}

async function seedAsk({ slug, itemId }: Seeded): Promise<number> {
  const asks = new AsksRepo(env.DB);
  await env.DB.batch(
    asks.createStatements(
      slug,
      itemId,
      {
        category: 'scope',
        ask: 'Ship with the pasted token?',
        commands: ['approve', 'reject'],
        recommended: 'approve',
      },
      JOB_ACTOR,
      AT,
      null,
    ),
  );
  const open = await asks.findOpen(itemId);
  if (open === null) {
    throw new Error('the seeded ask is missing');
  }
  return open.id;
}

async function seedRequest({ slug, itemId }: Seeded, handled = true): Promise<number> {
  const requests = new ItemRequestsRepo(env.DB);
  const id = await requests.create(slug, itemId, { kind: 'sprint', target: 'next' }, OWNER_ACTOR, AT);
  if (handled) {
    await requests.markHandled(
      { id, itemId },
      { jobId: 'job-test-1', result: 'declined', reason: 'Declined, the token is pasted here' },
      JOB_ACTOR,
      AT,
    );
  }
  return id;
}

async function seedImportedEvent({ itemId }: Seeded): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO item_events (item_id, at, actor_kind, actor, kind, before, after)
     VALUES (?1, ?2, 'import', 'octocat', 'imported', NULL, ?3) RETURNING id`,
  )
    .bind(
      itemId,
      AT,
      JSON.stringify({ title: 'Imported title', body: 'imported body', source: 'github', number: 7 }),
    )
    .first<{ id: number }>();
  if (row === null) {
    throw new Error('seeding an imported event inserted nothing');
  }
  return row.id;
}

const EVENT_SCRUB = `before = json_replace(before, '$.title', '${SCRUBBED_TEXT}', '$.body', '${SCRUBBED_TEXT}'),
  after = json_replace(after, '$.title', '${SCRUBBED_TEXT}', '$.body', '${SCRUBBED_TEXT}')`;

interface Guard {
  readonly table: GuardedTable;
  readonly seed: (seeded: Seeded) => Promise<number>;
  /** The scrub exactly as the repos write it. */
  readonly scrub: string;
  /** The columns the scrub is allowed to change. */
  readonly text: readonly string[];
  /** The row's text after the scrub. */
  readonly masked: Row;
  /** Every other column with another, otherwise valid, value: written beside the scrub it must be refused. */
  readonly others: Readonly<Record<string, string>>;
  /** Rewrites of the text column itself that are not the marker. */
  readonly rewrites: readonly string[];
  /** Columns with a once-only update of their own (0014), which is not this guard's to refuse when written alone. */
  readonly onceOnly?: readonly string[];
}

const GUARDS: readonly Guard[] = [
  {
    table: 'comments',
    seed: seedComment,
    scrub: `body = '${SCRUBBED_TEXT}'`,
    text: ['body'],
    masked: { body: SCRUBBED_TEXT },
    others: {
      id: 'id + 100000',
      item_id: 'item_id + 100000',
      kind: `'note'`,
      author_kind: `'owner'`,
      author: `'someone-else'`,
      job_id: `'job-other'`,
      created_at: `'${LATER}'`,
      source: `'import'`,
      source_url: `'https://example.test/c/1'`,
      reversed_by_decision_id: '1',
    },
    rewrites: [`body = 'rewritten'`, `body = '${SCRUBBED_TEXT} and more'`, `body = lower(body)`],
  },
  {
    table: 'asks',
    seed: seedAsk,
    scrub: `ask = '${SCRUBBED_TEXT}'`,
    text: ['ask'],
    masked: { ask: SCRUBBED_TEXT },
    others: {
      id: 'id + 100000',
      project_slug: `'another-project'`,
      item_id: 'item_id + 100000',
      category: `'money'`,
      commands: `'["go"]'`,
      recommended: `'reject'`,
      job_id: `'job-other'`,
      created_at: `'${LATER}'`,
      source: `'import'`,
      answered_by_decision_id: '1',
      withdrawn_at: `'${LATER}'`,
    },
    rewrites: [`ask = 'Another question?'`, `ask = '${SCRUBBED_TEXT}?'`],
    // The withdrawal of an open ask; "keeps a scrubbed open ask open" below covers it.
    onceOnly: ['withdrawn_at'],
  },
  {
    table: 'item_requests',
    seed: seedRequest,
    scrub: `reason = '${SCRUBBED_TEXT}'`,
    text: ['reason'],
    masked: { reason: SCRUBBED_TEXT },
    others: {
      id: 'id + 100000',
      project_slug: `'another-project'`,
      item_id: 'item_id + 100000',
      kind: `'priority'`,
      payload: `'{"kind":"priority","direction":"up"}'`,
      requested_at: `'${LATER}'`,
      handled_by_job_id: `'job-other'`,
      result: `'applied'`,
      handled_at: `'${LATER}'`,
    },
    rewrites: [`reason = 'Another reason'`, `reason = ''`],
  },
  {
    table: 'item_events',
    seed: seedImportedEvent,
    scrub: EVENT_SCRUB,
    text: ['before', 'after'],
    masked: {
      before: null,
      after: JSON.stringify({ title: SCRUBBED_TEXT, body: SCRUBBED_TEXT, source: 'github', number: 7 }),
    },
    others: {
      id: 'id + 100000',
      item_id: 'item_id + 100000',
      at: `'${LATER}'`,
      actor_kind: `'owner'`,
      actor: `'someone-else'`,
      job_id: `'job-other'`,
      kind: `'edited'`,
      duplicate_of: '1',
    },
    rewrites: [
      `after = json_replace(after, '$.title', 'Rewritten')`,
      `after = json_replace(after, '$.title', '${SCRUBBED_TEXT}', '$.body', '${SCRUBBED_TEXT}', '$.number', 8)`,
      `after = json_remove(after, '$.source')`,
      `after = NULL`,
      `before = '{"title":"invented"}'`,
    ],
  },
];

describe.each(GUARDS)('the scrub guard of $table (migration 0043)', (guard) => {
  it('decides every column of the table: the text, or refused beside it', async () => {
    expect([...guard.text, ...Object.keys(guard.others)].sort()).toEqual(await columnsOf(guard.table));
  });

  it('admits the marker in the text and keeps every other column', async () => {
    const id = await guard.seed(await seed());
    const before = await rowOf(guard.table, id);
    await env.DB.prepare(`UPDATE ${guard.table} SET ${guard.scrub} WHERE id = ?1`).bind(id).run();
    expect(await rowOf(guard.table, id)).toEqual({ ...before, ...guard.masked });
    // A second scrub is the same update again.
    await env.DB.prepare(`UPDATE ${guard.table} SET ${guard.scrub} WHERE id = ?1`).bind(id).run();
    expect(await rowOf(guard.table, id)).toEqual({ ...before, ...guard.masked });
  });

  it.each(Object.entries(guard.others))('refuses a scrub that also changes %s', async (column, value) => {
    const id = await guard.seed(await seed());
    const before = await rowOf(guard.table, id);
    await expect(
      env.DB.prepare(`UPDATE ${guard.table} SET ${guard.scrub}, ${column} = ${value} WHERE id = ?1`)
        .bind(id)
        .run(),
    ).rejects.toThrow();
    expect(await rowOf(guard.table, id)).toEqual(before);
  });

  const alone = Object.entries(guard.others).filter(([column]) => !(guard.onceOnly ?? []).includes(column));
  it.each(alone)('refuses a change of %s alone, before and after a scrub', async (column, value) => {
    const id = await guard.seed(await seed());
    const change = `UPDATE ${guard.table} SET ${column} = ${value} WHERE id = ?1`;
    const before = await rowOf(guard.table, id);
    await expect(env.DB.prepare(change).bind(id).run()).rejects.toThrow();
    expect(await rowOf(guard.table, id)).toEqual(before);
    await env.DB.prepare(`UPDATE ${guard.table} SET ${guard.scrub} WHERE id = ?1`).bind(id).run();
    await expect(env.DB.prepare(change).bind(id).run()).rejects.toThrow();
    expect(await rowOf(guard.table, id)).toEqual({ ...before, ...guard.masked });
  });

  it.each(guard.rewrites)('refuses a text that is not the marker: %s', async (set) => {
    const id = await guard.seed(await seed());
    const before = await rowOf(guard.table, id);
    await expect(
      env.DB.prepare(`UPDATE ${guard.table} SET ${set} WHERE id = ?1`).bind(id).run(),
    ).rejects.toThrow(APPEND_ONLY);
    expect(await rowOf(guard.table, id)).toEqual(before);
  });

  it('still refuses a delete, scrubbed or not', async () => {
    const id = await guard.seed(await seed());
    const remove = `DELETE FROM ${guard.table} WHERE id = ?1`;
    await expect(env.DB.prepare(remove).bind(id).run()).rejects.toThrow(APPEND_ONLY);
    await env.DB.prepare(`UPDATE ${guard.table} SET ${guard.scrub} WHERE id = ?1`).bind(id).run();
    await expect(env.DB.prepare(remove).bind(id).run()).rejects.toThrow(APPEND_ONLY);
  });
});

describe('the scrub guards beside the once-only updates', () => {
  it('leaves an unanswered request without a reason: nothing to mask, and the marker is refused', async () => {
    const seeded = await seed();
    const id = await seedRequest(seeded, false);
    await expect(
      env.DB.prepare(`UPDATE item_requests SET reason = ?2 WHERE id = ?1`).bind(id, SCRUBBED_TEXT).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await env.DB.batch([new ItemRequestsRepo(env.DB).scrubReasonStatement(seeded.itemId, [id])]);
    expect(await rowOf('item_requests', id)).toMatchObject({ reason: null, handled_at: null });
  });

  it('still answers a request once only after its reason was masked', async () => {
    const seeded = await seed();
    const id = await seedRequest(seeded);
    const requests = new ItemRequestsRepo(env.DB);
    await env.DB.batch([requests.scrubReasonStatement(seeded.itemId, [id])]);
    expect(
      await requests.markHandled(
        { id, itemId: seeded.itemId },
        { jobId: 'job-test-1', result: 'applied', reason: SCRUBBED_TEXT },
        JOB_ACTOR,
        LATER,
      ),
    ).toBe(false);
    expect(await rowOf('item_requests', id)).toMatchObject({
      result: 'declined',
      reason: SCRUBBED_TEXT,
      handled_at: AT,
    });
  });

  it('keeps a scrubbed open ask open: it is withdrawn once, like any other', async () => {
    const seeded = await seed();
    const id = await seedAsk(seeded);
    const asks = new AsksRepo(env.DB);
    await env.DB.batch([asks.scrubStatement(seeded.itemId, [id])]);
    expect(await asks.findOpen(seeded.itemId)).toMatchObject({
      id,
      ask: SCRUBBED_TEXT,
      commands: ['approve', 'reject'],
    });
    await env.DB.batch([asks.withdrawStatement(id, LATER)]);
    await expect(env.DB.batch([asks.withdrawStatement(id, AT)])).rejects.toThrow(APPEND_ONLY);
    expect(await rowOf('asks', id)).toMatchObject({ ask: SCRUBBED_TEXT, withdrawn_at: LATER });
  });

  it.each(['status', 'commented', 'labels', 'scrubbed'])(
    'refuses the event scrub on a %s event',
    async (kind) => {
      const { itemId } = await seed();
      const row = await env.DB.prepare(
        `INSERT INTO item_events (item_id, at, actor_kind, actor, kind, before, after)
       VALUES (?1, ?2, 'owner', 'owner', ?3, '{"title":"A"}', '{"title":"B"}') RETURNING id`,
      )
        .bind(itemId, AT, kind)
        .first<{ id: number }>();
      await expect(
        env.DB.prepare(`UPDATE item_events SET ${EVENT_SCRUB} WHERE id = ?1`)
          .bind(row?.id ?? 0)
          .run(),
      ).rejects.toThrow(APPEND_ONLY);
    },
  );
});

describe('the scrub statements of the repos (#477)', () => {
  it('masks only the named comments of the item', async () => {
    const seeded = await seed();
    const other: Seeded = { slug: seeded.slug, itemId: await seedTrackerItem(seeded.slug, 2) };
    const leaked = await seedComment(seeded);
    const kept = await seedComment(seeded, 'a clean comment');
    const foreign = await seedComment(other, 'another item, same leak');
    const before = await rowOf('comments', leaked);

    await env.DB.batch([new CommentsRepo(env.DB).scrubStatement(seeded.itemId, [leaked, foreign])]);

    expect(await rowOf('comments', leaked)).toEqual({ ...before, body: SCRUBBED_TEXT });
    expect(await rowOf('comments', kept)).toMatchObject({ body: 'a clean comment' });
    expect(await rowOf('comments', foreign)).toMatchObject({ body: 'another item, same leak' });
  });

  it('masks only the named asks and request reasons of the item', async () => {
    const seeded = await seed();
    const other: Seeded = { slug: seeded.slug, itemId: await seedTrackerItem(seeded.slug, 2) };
    const ask = await seedAsk(seeded);
    const foreignAsk = await seedAsk(other);
    const request = await seedRequest(seeded);
    const foreignRequest = await seedRequest(other);

    await env.DB.batch([
      new AsksRepo(env.DB).scrubStatement(seeded.itemId, [ask, foreignAsk]),
      new ItemRequestsRepo(env.DB).scrubReasonStatement(seeded.itemId, [request, foreignRequest]),
    ]);

    expect(await rowOf('asks', ask)).toMatchObject({ ask: SCRUBBED_TEXT });
    expect(await rowOf('asks', foreignAsk)).toMatchObject({ ask: 'Ship with the pasted token?' });
    expect(await rowOf('item_requests', request)).toMatchObject({
      reason: SCRUBBED_TEXT,
      result: 'declined',
    });
    expect(await rowOf('item_requests', foreignRequest)).toMatchObject({
      reason: 'Declined, the token is pasted here',
    });
  });

  it('names the ids a scrub cannot mask: unknown, another item’s, an unanswered request', async () => {
    const seeded = await seed();
    const other: Seeded = { slug: seeded.slug, itemId: await seedTrackerItem(seeded.slug, 2) };
    const comment = await seedComment(seeded);
    const foreignComment = await seedComment(other);
    const ask = await seedAsk(seeded);
    const answered = await seedRequest(seeded);
    const pending = await seedRequest(seeded, false);

    expect(await scrubIdsMissing(env.DB, 'comments', seeded.itemId, [])).toEqual([]);
    expect(await scrubIdsMissing(env.DB, 'comments', seeded.itemId, [comment])).toEqual([]);
    expect(
      await scrubIdsMissing(env.DB, 'comments', seeded.itemId, [foreignComment, comment, 999_999]),
    ).toEqual([foreignComment, 999_999].sort((a, b) => a - b));
    expect(await scrubIdsMissing(env.DB, 'asks', seeded.itemId, [ask])).toEqual([]);
    expect(await scrubIdsMissing(env.DB, 'asks', other.itemId, [ask])).toEqual([ask]);
    expect(await scrubIdsMissing(env.DB, 'requests', seeded.itemId, [answered, pending])).toEqual([pending]);
  });

  it('masks imported events with the created and edited ones, and records the ids a scrub named', async () => {
    const seeded = await seed();
    const imported = await seedImportedEvent(seeded);
    const events = new ItemEventsRepo(env.DB);

    const scrub = await events.scrub(seeded.itemId, OWNER_ACTOR, LATER, [], {
      events: true,
      comments: [4, 2],
      asks: [],
      requests: [9],
    });

    // The seeded item's `created` event and the imported one.
    expect(scrub.masked).toBe(2);
    expect(await events.find(seeded.itemId, imported)).toMatchObject({
      kind: 'imported',
      actorKind: 'import',
      actor: 'octocat',
      before: null,
      after: { title: SCRUBBED_TEXT, body: SCRUBBED_TEXT, source: 'github', number: 7 },
    });
    expect(await events.find(seeded.itemId, scrub.eventId)).toMatchObject({
      kind: 'scrubbed',
      before: null,
      after: { events: 2, fields: ['title', 'body'], comments: [4, 2], requests: [9] },
    });
  });

  it('leaves the history alone when a scrub names rows only', async () => {
    const seeded = await seed();
    const imported = await seedImportedEvent(seeded);
    const events = new ItemEventsRepo(env.DB);
    const scrub = await events.scrub(seeded.itemId, OWNER_ACTOR, LATER, [], {
      events: false,
      comments: [1],
      asks: [],
      requests: [],
    });
    expect(scrub.masked).toBe(0);
    expect(await events.find(seeded.itemId, imported)).toMatchObject({ after: { title: 'Imported title' } });
    expect((await events.find(seeded.itemId, scrub.eventId))?.after).toEqual({
      events: 0,
      fields: [],
      comments: [1],
    });
  });
});

describe('SprintsRepo.scrub (#477)', () => {
  const sprints = (): SprintsRepo => new SprintsRepo(env.DB);
  const sprintRow = async (slug: string, number: number): Promise<Row | null> =>
    env.DB.prepare('SELECT * FROM sprints WHERE project_slug = ?1 AND number = ?2')
      .bind(slug, number)
      .first<Row>();

  async function seedSprints(): Promise<string> {
    const { slug } = await seedTrackerProject();
    await sprints().create(slug, 1, {
      dueOn: '2026-12-01',
      description: 'the token is here',
      title: 'Leaky',
      at: AT,
    });
    await sprints().create(slug, 2, { dueOn: null, description: 'clean', title: 'Clean', at: AT });
    await sprints().update(slug, 1, { state: 'closed' }, LATER);
    return slug;
  }

  it.each([
    [['description'], { description: SCRUBBED_TEXT }],
    [['title'], { title: `${SCRUBBED_TEXT} 1`, title_key: `${SCRUBBED_TEXT} 1` }],
    [
      ['title', 'description'],
      { title: `${SCRUBBED_TEXT} 1`, title_key: `${SCRUBBED_TEXT} 1`, description: SCRUBBED_TEXT },
    ],
  ] as const)('masks %j and no other column, of that sprint alone', async (fields, masked) => {
    const slug = await seedSprints();
    const before = await sprintRow(slug, 1);
    const neighbour = await sprintRow(slug, 2);

    expect(await sprints().scrub(slug, 1, fields)).toBe('scrubbed');

    expect(await sprintRow(slug, 1)).toEqual({ ...before, ...masked });
    expect(await sprintRow(slug, 1)).toMatchObject({
      number: 1,
      due_on: '2026-12-01',
      state: 'closed',
      closed_at: LATER,
    });
    expect(await sprintRow(slug, 2)).toEqual(neighbour);
  });

  it('gives each scrubbed sprint its own title, found by it', async () => {
    const slug = await seedSprints();
    expect(await sprints().scrub(slug, 1, ['title'])).toBe('scrubbed');
    expect(await sprints().scrub(slug, 2, ['title'])).toBe('scrubbed');
    expect((await sprints().list(slug, 'all')).map((sprint) => sprint.title)).toEqual([
      `${SCRUBBED_TEXT} 1`,
      `${SCRUBBED_TEXT} 2`,
    ]);
    await expect(sprints().findByTitle(slug, `${SCRUBBED_TEXT} 2`)).resolves.toMatchObject({ number: 2 });
  });

  it('answers title-taken, writing nothing of the batch, when another sprint holds the marker title', async () => {
    const slug = await seedSprints();
    await sprints().create(slug, 3, { dueOn: null, description: '', title: `${SCRUBBED_TEXT} 1`, at: AT });
    const before = await sprintRow(slug, 1);
    const marker = env.DB.prepare(
      "INSERT INTO idempotency_keys (key, request_hash, created_at, expires_at) VALUES ('sprint-scrub-race', 'h', ?1, 0)",
    ).bind(AT);

    expect(await sprints().scrub(slug, 1, ['title', 'description'], [marker])).toBe('title-taken');

    expect(await sprintRow(slug, 1)).toEqual(before);
    await expect(
      env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = 'sprint-scrub-race'").first(),
    ).resolves.toBeNull();
  });
});
