import { applyD1Migrations, env } from 'cloudflare:test';
import { IdempotencyKeysRepo } from '@worker/db';

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

describe('migrations on a fresh D1', () => {
  it('apply cleanly and leave the tables plus the migrations ledger', async () => {
    const { results } = await env.DB.prepare(
      // `_cf_METADATA` is D1's own bookkeeping table.
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
    ).all<SqliteMasterRow>();

    expect(results.map((row) => row.name)).toEqual([
      'asks',
      'comments',
      'd1_migrations',
      'idempotency_keys',
      'import_map',
      'item_events',
      'item_labels',
      'item_requests',
      'items',
      'labels',
      'own_write_claims',
      'own_writes',
      'owner_connections',
      'owner_decisions',
      'owner_requests',
      'projects',
      'push_subscriptions',
      'push_test_sends',
      'slot_requests',
      'sprints',
      'webhook_deliveries',
    ]);
  });

  it('record each migration as applied exactly once', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
      name: string;
    }>();
    expect(results.map((row) => row.name)).toEqual([
      '0001_init.sql',
      '0005_owner_connections.sql',
      '0006_project_installation.sql',
      '0007_own_writes.sql',
      '0008_slot_requests.sql',
      '0009_push_subscriptions.sql',
      '0010_webhooks.sql',
      '0011_project_snooze.sql',
      '0012_owner_requests.sql',
      '0013_tracker.sql',
      '0014_decisions.sql',
      '0015_decision_guards.sql',
      '0016_item_approval.sql',
      '0019_event_scrub.sql',
    ]);
  });

  it('give push_subscriptions the columns of the #11 architect note, endpoint as the key', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(push_subscriptions)').all<{
      name: string;
      notnull: number;
      pk: number;
    }>();

    expect(results.map((column) => column.name)).toEqual([
      'endpoint',
      'p256dh',
      'auth',
      'user_agent',
      'created_at',
      'last_success_at',
      'failures',
    ]);
    expect(results.filter((column) => column.pk === 1).map((column) => column.name)).toEqual(['endpoint']);
  });

  it('give projects the columns the registry needs', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(projects)').all<{
      name: string;
      notnull: number;
    }>();

    expect(results.map((column) => column.name)).toEqual([
      'slug',
      'repo',
      'display_name',
      'routine_id',
      'cache_epoch',
      'added_at',
      'archived_at',
      'installation_id',
      'access_lost_at',
      'snoozed_at',
      'snoozed_until',
      'snooze_allows_urgent',
      'provider',
      'key_prefix',
      'tracker',
      'next_item_number',
      'cutover_at',
      'default_branch',
    ]);
    expect(results.filter((column) => column.notnull === 1).map((column) => column.name)).toEqual([
      'repo',
      'display_name',
      'cache_epoch',
      'added_at',
      'snooze_allows_urgent',
      'provider',
      'tracker',
      'next_item_number',
    ]);
  });

  it('give owner_connections the columns of ADR 0003 decision 4, environment as the key', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(owner_connections)').all<{
      name: string;
      notnull: number;
      pk: number;
      type: string;
    }>();

    expect(results.map((column) => column.name)).toEqual([
      'environment',
      'login',
      'user_id',
      'access_token_enc',
      'refresh_token_enc',
      'access_expires_at',
      'refresh_expires_at',
      'key_id',
      'version',
      'refreshing_until',
      'connected_at',
      'updated_at',
    ]);
    expect(results.filter((column) => column.pk === 1).map((column) => column.name)).toEqual(['environment']);
    expect(results.filter((column) => column.notnull === 0).map((column) => column.name)).toEqual([
      'refreshing_until',
    ]);
    expect(Object.fromEntries(results.map((column) => [column.name, column.type]))).toMatchObject({
      user_id: 'INTEGER',
      version: 'INTEGER',
      refreshing_until: 'INTEGER',
    });
  });

  it('give own_writes the columns #10 and #12 need, with the replay index', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(own_writes)').all<{
      name: string;
      notnull: number;
      pk: number;
    }>();
    expect(results.map((column) => column.name)).toEqual([
      'comment_id',
      'repo',
      'issue_number',
      'kind',
      'body_hash',
      'url',
      'created_at',
    ]);
    expect(results.filter((column) => column.pk === 1).map((column) => column.name)).toEqual(['comment_id']);
    expect(results.filter((column) => column.notnull === 0).map((column) => column.name)).toEqual([
      'body_hash',
    ]);
    const { results: index } = await env.DB.prepare("PRAGMA index_info('own_writes_recent')").all<{
      name: string;
    }>();
    expect(index.map((column) => column.name)).toEqual(['repo', 'issue_number', 'created_at']);
  });

  it('give webhook_deliveries a unique delivery id and a unique body hash (#12, threat model row 3)', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(webhook_deliveries)').all<{
      name: string;
      notnull: number;
      pk: number;
    }>();
    expect(results.map((column) => column.name)).toEqual([
      'delivery_id',
      'event',
      'repo',
      'body_sha256',
      'received_at',
    ]);
    expect(results.filter((column) => column.pk === 1).map((column) => column.name)).toEqual(['delivery_id']);
    expect(results.every((column) => column.notnull === 1)).toBe(true);

    const insert = env.DB.prepare(
      'INSERT INTO webhook_deliveries (delivery_id, event, repo, body_sha256, received_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    );
    await insert.bind('d-1', 'issues', 'acme/app', 'hash-1', '2026-10-01T00:00:00Z').run();
    await expect(
      insert.bind('d-2', 'issues', 'acme/app', 'hash-1', '2026-10-01T00:00:01Z').run(),
    ).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare('DELETE FROM webhook_deliveries').run();
  });

  it('keep the idempotency keys of the previous deploy through the 0014 rebuild, and they still replay', async () => {
    const db = env.MIGRATION_DB;
    const before = env.TEST_MIGRATIONS.filter((migration) => migration.name < '0014');
    await applyD1Migrations(db, before);
    const now = Date.parse('2026-11-05T10:00:00.000Z');
    await db
      .prepare(
        `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
         VALUES ('key-before-0014', 'hash', 201, 'comment', '7', '2026-11-05T09:59:00.000Z', ?1),
                ('key-in-flight', 'hash-2', NULL, NULL, NULL, '2026-11-05T09:59:30.000Z', ?2)`,
      )
      .bind(now + 60_000, now + 30_000)
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
           VALUES ('key-ask', 'h', 201, 'ask', '1', '2026-11-05T09:59:00.000Z', 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK/);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const keys = new IdempotencyKeysRepo(db);
    expect(await keys.claim('key-before-0014', 'hash', now, 30_000)).toEqual({
      state: 'done',
      status: 201,
      kind: 'comment',
      ref: '7',
    });
    expect(await keys.claim('key-in-flight', 'hash-2', now, 30_000)).toEqual({ state: 'in-flight' });
    // The rebuilt CHECK admits the new kinds and still refuses an unknown one.
    await db
      .prepare(
        `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
         VALUES ('key-ask', 'h', 201, 'ask', '1', '2026-11-05T09:59:00.000Z', 1)`,
      )
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
           VALUES ('key-x', 'h', 201, 'job', '1', '2026-11-05T09:59:00.000Z', 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'idempotency_keys'")
      .all<{ name: string }>();
    expect(results.map((row) => row.name)).toContain('idempotency_keys_expiry');
  });

  // #452: 0016 backfills the approval from the status and, for a done item, from its history; it fails closed.
  it('backfill the approval of the items already there', async () => {
    const db = env.MIGRATION_DB_0016;
    await applyD1Migrations(
      db,
      env.TEST_MIGRATIONS.filter((migration) => migration.name < '0016'),
    );
    const T0 = '2026-11-01T00:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES ('m16', 'a/m16', 'm16', 0, ?1)`,
      )
      .bind(T0)
      .run();
    const insert = (number: number, status: string, closed: boolean) =>
      db
        .prepare(
          `INSERT INTO items (project_slug, number, kind, status, title, closed_at, closed_reason, created_by_kind,
             created_by, created_at, updated_at)
           VALUES ('m16', ?1, 'feature', ?2, 'Item', ?3, ?4, 'owner', 'owner', ?5, ?5)`,
        )
        .bind(number, status, closed ? T0 : null, closed ? 'done' : null, T0)
        .run();
    await insert(1, 'proposed', false);
    await insert(2, 'in-progress', false);
    await insert(3, 'done', true); // Went through work: approved.
    await insert(4, 'done', true); // Closed by the release decision straight from proposed: not approved.
    const event = (number: number, kind: string, after: unknown, at: string) =>
      db
        .prepare(
          `INSERT INTO item_events (item_id, at, actor_kind, actor, kind, before, after)
           SELECT id, ?2, 'owner', 'owner', ?3, NULL, ?4 FROM items WHERE project_slug = 'm16' AND number = ?1`,
        )
        .bind(number, at, kind, JSON.stringify(after))
        .run();
    await event(2, 'status', { status: 'approved' }, '2026-11-02T00:00:00.000Z');
    await event(3, 'status', { status: 'in-progress' }, '2026-11-03T00:00:00.000Z');
    await event(3, 'closed', { status: 'done' }, '2026-11-04T00:00:00.000Z');
    await event(4, 'closed', { status: 'done' }, '2026-11-04T00:00:00.000Z');

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const { results } = await db
      .prepare(`SELECT number, approved_at FROM items WHERE project_slug = 'm16' ORDER BY number`)
      .all<{ number: number; approved_at: string | null }>();
    expect(results).toEqual([
      { number: 1, approved_at: null },
      { number: 2, approved_at: '2026-11-02T00:00:00.000Z' },
      { number: 3, approved_at: '2026-11-03T00:00:00.000Z' },
      { number: 4, approved_at: null },
    ]);
  });

  // #462: 0019 rebuilds item_events (the `scrubbed` kind) and idempotency_keys (the `event` result) keeping every row.
  it('keep the events and the idempotency keys through the 0019 rebuild', async () => {
    const db = env.MIGRATION_DB_0019;
    await applyD1Migrations(
      db,
      env.TEST_MIGRATIONS.filter((migration) => migration.name < '0019'),
    );
    const T0 = '2026-11-01T00:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES ('m19', 'a/m19', 'm19', 0, ?1)`,
      )
      .bind(T0)
      .run();
    await db
      .prepare(
        `INSERT INTO items (project_slug, number, kind, status, title, created_by_kind, created_by, created_at,
           updated_at) VALUES ('m19', 1, 'feature', 'proposed', 'Item', 'owner', 'owner', ?1, ?1)`,
      )
      .bind(T0)
      .run();
    await db
      .prepare(
        `INSERT INTO item_events (id, item_id, at, actor_kind, actor, job_id, kind, before, after)
         SELECT 41, id, ?1, 'job', 'pm', 'job-1', 'edited', '{"title":"A"}', '{"title":"B"}' FROM items
         WHERE project_slug = 'm19'`,
      )
      .bind(T0)
      .run();
    await db
      .prepare(
        `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
         VALUES ('key-before-0019', 'hash', 201, 'comment', '7', ?1, ?2)`,
      )
      .bind(T0, Date.parse(T0) + 60_000)
      .run();

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(
      await db.prepare('SELECT id, actor, job_id, kind, before, after FROM item_events').all(),
    ).toMatchObject({
      results: [
        {
          id: 41,
          actor: 'pm',
          job_id: 'job-1',
          kind: 'edited',
          before: '{"title":"A"}',
          after: '{"title":"B"}',
        },
      ],
    });
    expect(
      await new IdempotencyKeysRepo(db).claim('key-before-0019', 'hash', Date.parse(T0), 30_000),
    ).toEqual({
      state: 'done',
      status: 201,
      kind: 'comment',
      ref: '7',
    });
    // The rebuilt CHECKs admit the new values.
    await db
      .prepare(
        `INSERT INTO item_events (item_id, at, actor_kind, actor, kind, after)
         SELECT id, ?1, 'owner', 'owner', 'scrubbed', '{"events":0}' FROM items WHERE project_slug = 'm19'`,
      )
      .bind(T0)
      .run();
    await db
      .prepare(
        `INSERT INTO idempotency_keys (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
         VALUES ('key-event', 'h', 201, 'event', '42', ?1, 1)`,
      )
      .bind(T0)
      .run();
    const { results } = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger')
           AND tbl_name IN ('item_events', 'idempotency_keys') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      'idempotency_keys_expiry',
      'item_events_append_only_delete',
      'item_events_append_only_update',
      'item_events_item',
      'item_events_never_replaced',
    ]);
  });

  describe('item_events after 0019 stay append-only but for the scrub', () => {
    const T0 = '2026-11-01T00:00:00.000Z';
    const scrubbed = (column: string): string =>
      `json_replace(${column}, '$.title', '[scrubbed]', '$.body', '[scrubbed]')`;

    async function seedEvent(kind: string, before: unknown, after: unknown): Promise<number> {
      const slug = `s19-${crypto.randomUUID().slice(0, 8)}`;
      await env.DB.prepare(
        `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES (?1, ?2, ?1, 0, ?3)`,
      )
        .bind(slug, `a/${slug}`, T0)
        .run();
      await env.DB.prepare(
        `INSERT INTO items (project_slug, number, kind, status, title, created_by_kind, created_by, created_at,
           updated_at) VALUES (?1, 1, 'feature', 'proposed', 'Item', 'owner', 'owner', ?2, ?2)`,
      )
        .bind(slug, T0)
        .run();
      const row = await env.DB.prepare(
        `INSERT INTO item_events (item_id, at, actor_kind, actor, kind, before, after)
         SELECT id, ?2, 'owner', 'owner', ?3, ?4, ?5 FROM items WHERE project_slug = ?1 RETURNING id`,
      )
        .bind(slug, T0, kind, before === null ? null : JSON.stringify(before), JSON.stringify(after))
        .first<{ id: number }>();
      if (row === null) {
        throw new Error('seeding an event inserted nothing');
      }
      return row.id;
    }

    it('admits the scrub of a created or edited event, masking title and body only', async () => {
      const cases = [
        ['edited', { title: 'Old', body: 'leak', tier: 'light' }],
        ['created', null],
      ] as const;
      for (const [kind, before] of cases) {
        const id = await seedEvent(kind, before, { title: 'New', body: 'clean', tier: 'heavy' });
        await env.DB.prepare(
          `UPDATE item_events SET before = ${scrubbed('before')}, after = ${scrubbed('after')} WHERE id = ?1`,
        )
          .bind(id)
          .run();
        const row = await env.DB.prepare('SELECT before, after FROM item_events WHERE id = ?1')
          .bind(id)
          .first<{ before: string | null; after: string }>();
        expect(JSON.parse(row?.after ?? 'null')).toEqual({
          title: '[scrubbed]',
          body: '[scrubbed]',
          tier: 'heavy',
        });
        const masked = row?.before === null || row?.before === undefined ? null : JSON.parse(row.before);
        expect(masked).toEqual(
          before === null ? null : { title: '[scrubbed]', body: '[scrubbed]', tier: 'light' },
        );
      }
    });

    it.each([
      ['another member', `after = json_replace(after, '$.tier', 'light')`, 'edited'],
      ['another value', `after = json_replace(after, '$.title', 'Rewritten')`, 'edited'],
      ['the actor', "actor = 'pm'", 'edited'],
      ['the time', "at = '2026-12-01T00:00:00.000Z'", 'edited'],
      ['the kind', "kind = 'status'", 'edited'],
      [
        'a status event, scrub-shaped',
        `before = ${scrubbed('before')}, after = ${scrubbed('after')}`,
        'status',
      ],
      ['the after, blanked', 'after = NULL', 'edited'],
    ])('refuses an update of %s', async (_, set, kind) => {
      const id = await seedEvent(kind, { title: 'Old' }, { title: 'New', tier: 'heavy' });
      await expect(
        env.DB.prepare(`UPDATE item_events SET ${set} WHERE id = ?1`).bind(id).run(),
      ).rejects.toThrow(/append-only/);
    });

    it('still refuses a delete', async () => {
      const id = await seedEvent('edited', { title: 'Old' }, { title: 'New' });
      await expect(env.DB.prepare('DELETE FROM item_events WHERE id = ?1').bind(id).run()).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
