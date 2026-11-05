import { env } from 'cloudflare:test';
import { AT, OWNER_ACTOR, seedTrackerProject } from '../../testing/tracker-kit';
import { ItemEventsRepo } from './item-events.repo';
import { ItemsRepo, type NewItem } from './items.repo';
import { SprintsRepo } from './sprints.repo';
import { TrackerProjectsRepo } from './tracker-projects.repo';

const items = (): ItemsRepo => new ItemsRepo(env.DB);
const events = (): ItemEventsRepo => new ItemEventsRepo(env.DB);
const LATER = '2026-11-04T11:00:00.000Z';

function newItem(number: number, overrides: Partial<NewItem> = {}): NewItem {
  return {
    number,
    kind: 'feature',
    status: 'proposed',
    severity: null,
    tier: null,
    sprint: null,
    title: `Item ${String(number)}`,
    body: 'What and why',
    flags: [],
    ...overrides,
  };
}

async function create(slug: string, overrides: Partial<NewItem> = {}): Promise<number> {
  const number = await new TrackerProjectsRepo(env.DB).allocateItemNumber(slug);
  if (number === null) {
    throw new Error('no number');
  }
  await items().create(slug, newItem(number, overrides), OWNER_ACTOR, AT);
  return number;
}

async function countRows(table: 'items' | 'item_events' | 'item_labels'): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('ItemsRepo', () => {
  it('creates an item with its flags and a created event, and reads it back by number', async () => {
    const { slug } = await seedTrackerProject(310);
    const number = await create(slug, { flags: ['security', 'architect-note'], tier: 'heavy' });
    const item = await items().findByNumber(slug, number);
    expect(item).toMatchObject({
      number: 310,
      kind: 'feature',
      status: 'proposed',
      tier: 'heavy',
      sprintNumber: null,
      title: 'Item 310',
      body: 'What and why',
      flags: ['architect-note', 'security'],
      closedAt: null,
      createdByKind: 'owner',
      createdBy: 'owner',
      createdAt: AT,
      updatedAt: AT,
      version: 1,
      source: 'console',
    });
    const trail = await events().list(item?.id ?? 0, 0, 10);
    expect(trail).toEqual([
      expect.objectContaining({
        kind: 'created',
        actorKind: 'owner',
        before: null,
        after: expect.objectContaining({ title: 'Item 310', flags: ['architect-note', 'security'] }),
      }),
    ]);
    await expect(items().findByNumber(slug, 999)).resolves.toBeNull();
  });

  it('writes nothing when a flag is not one of the project labels', async () => {
    const { slug } = await seedTrackerProject();
    const before = await Promise.all([countRows('items'), countRows('item_events')]);
    await expect(create(slug, { flags: ['no-such-label'] })).rejects.toThrow(/FOREIGN KEY/);
    expect(await Promise.all([countRows('items'), countRows('item_events')])).toEqual(before);
  });

  it('refuses a column-backed label as a flag row and a sprint of another project', async () => {
    const { slug } = await seedTrackerProject();
    const other = await seedTrackerProject();
    await new SprintsRepo(env.DB).create(other.slug, 1, { dueOn: null, description: '', at: AT });
    const foreign = await new SprintsRepo(env.DB).findByNumber(other.slug, 1);
    await expect(create(slug, { flags: ['status:qa'] })).rejects.toThrow(/CHECK constraint failed/);
    await expect(create(slug, { sprint: { id: foreign?.id ?? 0, number: 1 } })).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it('updates at the expected version, bumps it and records the event with the flags in the same batch', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug, { flags: ['needs-design'] });
    const item = await items().findByNumber(slug, number);
    const event = {
      kind: 'labels' as const,
      before: { flags: ['needs-design'] },
      after: { flags: ['security'] },
    };
    expect(
      await items().update(
        item?.id ?? 0,
        1,
        {},
        { add: ['security'], remove: ['needs-design'] },
        OWNER_ACTOR,
        [event],
        LATER,
      ),
    ).toBe(true);
    await expect(items().findByNumber(slug, number)).resolves.toMatchObject({
      flags: ['security'],
      version: 2,
      updatedAt: LATER,
    });
    const trail = await events().list(item?.id ?? 0, 0, 10);
    expect(trail.map((row) => [row.kind, row.after])).toEqual([
      ['created', expect.anything()],
      ['labels', { flags: ['security'] }],
    ]);
  });

  it('writes nothing at a stale version: no column, no flag and no event (412 item-version)', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug);
    const item = await items().findByNumber(slug, number);
    const id = item?.id ?? 0;
    const event = { kind: 'edited' as const, before: { title: 'Item' }, after: { title: 'B' } };
    await items().update(id, 1, { title: 'A' }, { add: [], remove: [] }, OWNER_ACTOR, [event], LATER);
    expect(
      await items().update(
        id,
        1,
        { title: 'B' },
        { add: ['security'], remove: [] },
        OWNER_ACTOR,
        [event],
        LATER,
      ),
    ).toBe(false);
    await expect(items().findByNumber(slug, number)).resolves.toMatchObject({
      title: 'A',
      version: 2,
      flags: [],
    });
    expect(await events().list(id, 0, 10)).toHaveLength(2);
  });

  it('rethrows a failure at the current version instead of calling it stale', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug);
    const id = (await items().findByNumber(slug, number))?.id ?? 0;
    const event = { kind: 'labels' as const, before: { flags: [] }, after: { flags: ['no-such-label'] } };
    await expect(
      items().update(id, 1, {}, { add: ['no-such-label'], remove: [] }, OWNER_ACTOR, [event], LATER),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(items().findByNumber(slug, number)).resolves.toMatchObject({ version: 1 });
  });

  it('writes one event per kind of change in the same batch', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug);
    const id = (await items().findByNumber(slug, number))?.id ?? 0;
    const status = { kind: 'status' as const, before: { status: 'proposed' }, after: { status: 'approved' } };
    const edited = { kind: 'edited' as const, before: { title: 'Item' }, after: { title: 'New' } };
    expect(
      await items().update(
        id,
        1,
        { status: 'approved', title: 'New', approvedAt: LATER },
        { add: [], remove: [] },
        OWNER_ACTOR,
        [status, edited],
        LATER,
      ),
    ).toBe(true);
    expect((await events().list(id, 0, 10)).map((row) => row.kind)).toEqual(['created', 'status', 'edited']);
  });

  it('closes as done with the status and refuses a done item that is open', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug);
    const item = await items().findByNumber(slug, number);
    const event = { kind: 'closed' as const, before: { status: 'proposed' }, after: { status: 'done' } };
    await expect(
      items().update(
        item?.id ?? 0,
        1,
        { status: 'done' },
        { add: [], remove: [] },
        OWNER_ACTOR,
        [event],
        LATER,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect(
      await items().update(
        item?.id ?? 0,
        1,
        { status: 'done', closedAt: LATER, closedReason: 'done' },
        { add: [], remove: [] },
        OWNER_ACTOR,
        [event],
        LATER,
      ),
    ).toBe(true);
    await expect(items().findByNumber(slug, number)).resolves.toMatchObject({
      status: 'done',
      closedAt: LATER,
      closedReason: 'done',
    });
  });

  // #452: the owner's approval is a recorded fact, kept by the schema.
  it('records the approval of an item created in a workable status, and none for a proposed or done one', async () => {
    const { slug } = await seedTrackerProject();
    const approvedAtOf = async (number: number) => (await items().findByNumber(slug, number))?.approvedAt;
    await expect(approvedAtOf(await create(slug, { status: 'in-progress' }))).resolves.toBe(AT);
    await expect(approvedAtOf(await create(slug))).resolves.toBeNull();
    await expect(approvedAtOf(await create(slug, { status: 'done' }))).resolves.toBeNull();
  });

  it('refuses a workable status without an approval, and never clears or changes one', async () => {
    const { slug } = await seedTrackerProject();
    const id = (await items().findByNumber(slug, await create(slug)))?.id ?? 0;
    const move = (patch: Parameters<ItemsRepo['update']>[2], version: number) =>
      items().update(id, version, patch, { add: [], remove: [] }, OWNER_ACTOR, [], LATER);
    await expect(move({ status: 'in-progress' }, 1)).rejects.toThrow(/approved_at must be set/);
    await expect(move({ status: 'in-progress', approvedAt: LATER }, 1)).resolves.toBe(true);
    await expect(move({ approvedAt: AT }, 2)).rejects.toThrow(/never cleared or changed/);
    await expect(move({ status: 'proposed' }, 2)).resolves.toBe(true);
    await expect(items().findByNumber(slug, 1)).resolves.toMatchObject({
      status: 'proposed',
      approvedAt: LATER,
    });
  });

  it('lists in number order with filters and a cursor, without bodies', async () => {
    const { slug } = await seedTrackerProject();
    await new SprintsRepo(env.DB).create(slug, 1, { dueOn: '2026-11-17', description: '', at: AT });
    const sprint = await new SprintsRepo(env.DB).findByNumber(slug, 1);
    const a = await create(slug, { kind: 'bug', severity: 'high' });
    const b = await create(slug, { flags: ['security'], sprint: { id: sprint?.id ?? 0, number: 1 } });
    const c = await create(slug, { status: 'done' });

    const open = await items().list(slug, { state: 'open' }, 0, 1);
    expect(open.items.map((item) => item.number)).toEqual([a]);
    expect(open.next).toBe(a);
    expect('body' in (open.items[0] ?? {})).toBe(false);
    const rest = await items().list(slug, { state: 'open' }, a, 1);
    expect(rest).toMatchObject({ items: [{ number: b, sprintNumber: 1, flags: ['security'] }], next: null });

    const numbersOf = async (filter: Parameters<ItemsRepo['list']>[1]) =>
      (await items().list(slug, filter, 0, 100)).items.map((item) => item.number);
    await expect(numbersOf({ state: 'closed' })).resolves.toEqual([c]);
    await expect(numbersOf({ state: 'all' })).resolves.toEqual([a, b, c]);
    await expect(numbersOf({ state: 'all', kind: 'bug', severity: 'high' })).resolves.toEqual([a]);
    await expect(numbersOf({ state: 'all', sprint: 1 })).resolves.toEqual([b]);
    await expect(numbersOf({ state: 'all', sprint: 'none' })).resolves.toEqual([a, c]);
    await expect(numbersOf({ state: 'all', flag: 'security' })).resolves.toEqual([b]);
    await expect(numbersOf({ state: 'all', status: 'done' })).resolves.toEqual([c]);
  });

  it('refuses INSERT OR REPLACE / REPLACE INTO over an item or an event, keeping plain inserts working', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug);
    const item = await items().findByNumber(slug, number);
    const id = item?.id ?? 0;
    const [event] = await events().list(id, 0, 1);
    for (const verb of ['INSERT OR REPLACE INTO', 'REPLACE INTO']) {
      await expect(
        env.DB.prepare(
          `${verb} items (id, project_slug, number, kind, status, title, created_by_kind, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'bug', 'proposed', 'Replaced', 'owner', 'owner', ?4, ?4)`,
        )
          .bind(id, slug, number, AT)
          .run(),
      ).rejects.toThrow(/never deleted/);
      // Through the UNIQUE (project_slug, number) with a fresh id.
      await expect(
        env.DB.prepare(
          `${verb} items (project_slug, number, kind, status, title, created_by_kind, created_by, created_at, updated_at)
           VALUES (?1, ?2, 'bug', 'proposed', 'Replaced', 'owner', 'owner', ?3, ?3)`,
        )
          .bind(slug, number, AT)
          .run(),
      ).rejects.toThrow(/never deleted/);
      await expect(
        env.DB.prepare(
          `${verb} item_events (id, item_id, at, actor_kind, actor, kind) VALUES (?1, ?2, ?3, 'owner', 'x', 'edited')`,
        )
          .bind(event?.id ?? 0, id, AT)
          .run(),
      ).rejects.toThrow(/append-only/);
    }
    await expect(items().findByNumber(slug, number)).resolves.toMatchObject({
      title: `Item ${String(number)}`,
    });
    expect(await events().list(id, 0, 10)).toEqual([event]);
    await expect(create(slug)).resolves.toBe(number + 1);
  });

  it('never deletes an item, and its events can be neither changed nor deleted', async () => {
    const { slug } = await seedTrackerProject();
    const number = await create(slug);
    await expect(
      env.DB.prepare('DELETE FROM items WHERE project_slug = ?1 AND number = ?2').bind(slug, number).run(),
    ).rejects.toThrow(/never deleted/);
    await expect(env.DB.prepare("UPDATE item_events SET actor = 'someone'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare('DELETE FROM item_events').run()).rejects.toThrow(/append-only/);
  });

  it('exposes no update or delete for events (append-only in the repo API too)', () => {
    const methods = Object.getOwnPropertyNames(ItemEventsRepo.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods).toEqual(['list']);
  });
});
