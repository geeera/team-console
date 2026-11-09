import { applyD1Migrations, env } from 'cloudflare:test';
import { IdempotencyKeysRepo } from '@worker/db';
import { OWNER_ACCOUNT_ID, OWNER_USER_ID } from '@shared/contracts';

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
      'account_members',
      'accounts',
      'asks',
      'audit_events',
      'comments',
      'd1_migrations',
      'idempotency_keys',
      'import_map',
      'installations',
      'invites',
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
      'sessions',
      'slot_requests',
      'sprints',
      'user_connections',
      'users',
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
      '0017_item_approval_guards.sql',
      '0018_accounts.sql',
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
      'account_id',
      'repo_id',
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
      'account_id',
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
});

// #457: 0017 holds direct SQL to what the Worker writes — a UTC timestamp, set only as the item enters work.
describe('items.approved_at guards (0017)', () => {
  const T0 = '2026-11-01T00:00:00.000Z';
  let number = 0;

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES ('m17', 'a/m17', 'm17', 0, ?1)`,
    )
      .bind(T0)
      .run();
  });

  const insert = (status: string, approvedAt: unknown) => {
    number += 1;
    const closed = status === 'done';
    return env.DB.prepare(
      `INSERT INTO items (project_slug, number, kind, status, title, closed_at, closed_reason, created_by_kind,
         created_by, created_at, updated_at, approved_at)
       VALUES ('m17', ?1, 'feature', ?2, 'Item', ?3, ?4, 'owner', 'owner', ?5, ?5, ?6)`,
    )
      .bind(number, status, closed ? T0 : null, closed ? 'done' : null, T0, approvedAt)
      .run()
      .then(() => number);
  };
  const update = (item: number, set: string, ...values: unknown[]) =>
    env.DB.prepare(`UPDATE items SET ${set} WHERE project_slug = 'm17' AND number = ?1`)
      .bind(item, ...values)
      .run();

  it.each([T0, '2026-11-01T00:00:00Z'])('accept the timestamp %s on a workable item', async (at) => {
    await expect(insert('approved', at)).resolves.toBeGreaterThan(0);
  });

  it.each([
    'yes',
    '1',
    '2026-11-01',
    '2026-11-01 00:00:00',
    '2026-11-01T00:00:00+02:00',
    '2026-02-30T00:00:00.000Z',
    '2026-11-01T25:00:00.000Z',
    '2026-11-01T00:00:00.000Zjunk',
  ])('refuse %j as an approval time, on insert and on update', async (value) => {
    await expect(insert('approved', value)).rejects.toThrow(/approved_at must be a UTC timestamp/);
    const item = await insert('proposed', null);
    await expect(update(item, "status = 'approved', approved_at = ?2", value)).rejects.toThrow(
      /approved_at must be a UTC timestamp/,
    );
  });

  it('refuse a number as an approval time', async () => {
    await expect(insert('approved', 1_762_000_000)).rejects.toThrow(/approved_at must be a UTC timestamp/);
  });

  it.each(['proposed', 'done'])('refuse an approval inserted on a %s item', async (status) => {
    await expect(insert(status, T0)).rejects.toThrow(/set only while the item enters a workable status/);
  });

  it('refuse setting the approval while the item stays proposed or moves to done', async () => {
    const proposed = await insert('proposed', null);
    await expect(update(proposed, 'approved_at = ?2', T0)).rejects.toThrow(/workable status/);
    await expect(
      update(proposed, "status = 'done', closed_at = ?2, closed_reason = 'done', approved_at = ?2", T0),
    ).rejects.toThrow(/workable status/);
  });

  it('allow the approval in the statement that makes the item workable, and keep it once it is done', async () => {
    const item = await insert('proposed', null);
    await update(item, "status = 'in-progress', approved_at = ?2", T0);
    await update(item, "status = 'done', closed_at = ?2, closed_reason = 'done'", T0);
    const row = await env.DB.prepare(
      `SELECT status, approved_at FROM items WHERE project_slug = 'm17' AND number = ?1`,
    )
      .bind(item)
      .first();
    expect(row).toEqual({ status: 'done', approved_at: T0 });
  });
});

// #465, ADR 0008 decision 1: 0018 attaches what exists to the owner's account; the owner's user and membership come
// only from an unambiguous owner connection (fail closed).
describe('the 0018 accounts backfill', () => {
  const T0 = '2026-11-01T00:00:00.000Z';

  async function migrateUpTo0018(db: D1Database): Promise<void> {
    await applyD1Migrations(
      db,
      env.TEST_MIGRATIONS.filter((migration) => migration.name < '0018'),
    );
  }

  async function seedProject(db: D1Database, slug: string, repo: string, installationId: number | null) {
    await db
      .prepare(
        `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, installation_id)
         VALUES (?1, ?2, ?1, 0, ?3, ?4)`,
      )
      .bind(slug, repo, T0, installationId)
      .run();
  }

  async function seedConnection(db: D1Database, environment: string, login: string, userId: number) {
    await db
      .prepare(
        `INSERT INTO owner_connections (environment, login, user_id, access_token_enc, refresh_token_enc,
           access_expires_at, refresh_expires_at, key_id, connected_at, updated_at)
         VALUES (?1, ?2, ?3, 'ciphertext', 'ciphertext', 1, 2, 'abcd1234', ?4, ?4)`,
      )
      .bind(environment, login, userId, T0)
      .run();
  }

  async function rows<T>(db: D1Database, sql: string): Promise<T[]> {
    return (await db.prepare(sql).all<T>()).results;
  }

  it('creates the owner account, user and membership and attaches every project and installation', async () => {
    const db = env.MIGRATION_DB_0018;
    await migrateUpTo0018(db);
    await seedConnection(db, 'dev', 'geeera', 1001);
    await seedProject(db, 'tc', 'geeera/team-console', 42);
    await seedProject(db, 'storify', 'geeera/storify', 42);
    await seedProject(db, 'other', 'acme/other', 77);
    await seedProject(db, 'legacy', 'geeera/legacy', null);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(await rows(db, 'SELECT id, slug, plan, entitlements, suspended_at FROM accounts')).toEqual([
      { id: OWNER_ACCOUNT_ID, slug: 'owner', plan: 'team', entitlements: '{}', suspended_at: null },
    ]);
    expect(
      await rows(db, 'SELECT id, provider, provider_user_id, login, email, access_subject FROM users'),
    ).toEqual([
      {
        id: OWNER_USER_ID,
        provider: 'github',
        provider_user_id: '1001',
        login: 'geeera',
        email: null,
        access_subject: null,
      },
    ]);
    expect(await rows(db, 'SELECT account_id, user_id, role FROM account_members')).toEqual([
      { account_id: OWNER_ACCOUNT_ID, user_id: OWNER_USER_ID, role: 'owner' },
    ]);
    expect(await rows(db, 'SELECT slug, account_id, repo_id FROM projects ORDER BY slug')).toEqual(
      ['legacy', 'other', 'storify', 'tc'].map((slug) => ({
        slug,
        account_id: OWNER_ACCOUNT_ID,
        repo_id: null,
      })),
    );
    expect(
      await rows(
        db,
        `SELECT account_id, provider, installation_id, account_login, linked_by_user_id, linked_at, unlinked_at
         FROM installations ORDER BY installation_id`,
      ),
    ).toEqual([
      {
        account_id: OWNER_ACCOUNT_ID,
        provider: 'github',
        installation_id: '42',
        account_login: 'geeera',
        linked_by_user_id: OWNER_USER_ID,
        linked_at: T0,
        unlinked_at: null,
      },
      {
        account_id: OWNER_ACCOUNT_ID,
        provider: 'github',
        installation_id: '77',
        account_login: 'acme',
        linked_by_user_id: OWNER_USER_ID,
        linked_at: T0,
        unlinked_at: null,
      },
    ]);
    expect(await rows(db, 'SELECT kind, actor_kind, actor, target FROM audit_events ORDER BY id')).toEqual([
      { kind: 'account.created', actor_kind: 'system', actor: 'migration', target: 'owner' },
      { kind: 'member.joined', actor_kind: 'system', actor: 'migration', target: OWNER_USER_ID },
      { kind: 'installation.linked', actor_kind: 'system', actor: 'migration', target: 'github:42' },
      { kind: 'installation.linked', actor_kind: 'system', actor: 'migration', target: 'github:77' },
    ]);
    // The token pair stays where the code reads it; T-4 moves it.
    expect(await rows(db, 'SELECT COUNT(*) AS n FROM user_connections')).toEqual([{ n: 0 }]);
    expect(await rows(db, 'SELECT COUNT(*) AS n FROM owner_connections')).toEqual([{ n: 1 }]);
  });

  it('creates no user and no membership without an owner connection', async () => {
    const db = env.MIGRATION_DB_0018_NO_OWNER;
    await migrateUpTo0018(db);
    await seedProject(db, 'tc', 'geeera/team-console', 42);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(await rows(db, 'SELECT id FROM accounts')).toEqual([{ id: OWNER_ACCOUNT_ID }]);
    expect(await rows(db, 'SELECT id FROM users')).toEqual([]);
    expect(await rows(db, 'SELECT user_id FROM account_members')).toEqual([]);
    expect(await rows(db, 'SELECT account_id FROM projects')).toEqual([{ account_id: OWNER_ACCOUNT_ID }]);
    expect(await rows(db, 'SELECT installation_id, linked_by_user_id FROM installations')).toEqual([
      { installation_id: '42', linked_by_user_id: null },
    ]);
    expect(await rows(db, 'SELECT kind FROM audit_events ORDER BY id')).toEqual([
      { kind: 'account.created' },
      { kind: 'installation.linked' },
    ]);
  });

  it('creates no user and no membership when the connections name different GitHub users', async () => {
    const db = env.MIGRATION_DB_0018_AMBIGUOUS;
    await migrateUpTo0018(db);
    await seedConnection(db, 'dev', 'geeera', 1001);
    await seedConnection(db, 'local', 'someone-else', 2002);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(await rows(db, 'SELECT id FROM users')).toEqual([]);
    expect(await rows(db, 'SELECT user_id FROM account_members')).toEqual([]);
    expect(await rows(db, 'SELECT id FROM accounts')).toEqual([{ id: OWNER_ACCOUNT_ID }]);
  });
});

// #465: the schema itself holds the account invariants, whichever code path writes (threat model C9).
describe('the 0018 account guards', () => {
  const T0 = '2026-11-09T00:00:00.000Z';
  const OTHER_ACCOUNT = '01M6YSNJ00000000000000000Z';
  const OTHER_USER = '01M6YSNJ00000000000000000Y';
  const run = (sql: string, ...values: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...values)
      .run();

  beforeAll(async () => {
    await run(
      `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'acme', 'Acme', ?2)`,
      OTHER_ACCOUNT,
      T0,
    );
    await run(
      `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
       VALUES (?1, 'github', '3003', 'acme-owner', ?2, ?2)`,
      OTHER_USER,
      T0,
    );
    await run(
      `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`,
      OTHER_ACCOUNT,
      OTHER_USER,
      T0,
    );
  });

  it('defaults a new project to the owner account, the id contracts names', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(projects)').all<{
      name: string;
      dflt_value: string | null;
    }>();
    expect(results.find((column) => column.name === 'account_id')?.dflt_value).toBe(`'${OWNER_ACCOUNT_ID}'`);
    await run(
      `INSERT INTO projects (slug, repo, display_name, added_at) VALUES ('g1', 'acme/g1', 'g1', ?1)`,
      T0,
    );
    expect(
      await env.DB.prepare(`SELECT account_id FROM projects WHERE slug = 'g1'`).first('account_id'),
    ).toBe(OWNER_ACCOUNT_ID);
  });

  it('refuses a project of an account that does not exist', async () => {
    await expect(
      run(
        `INSERT INTO projects (slug, repo, display_name, added_at, account_id) VALUES ('g2', 'acme/g2', 'g2', ?1, ?2)`,
        T0,
        '01M6YSNJ0000000000000000XX',
      ),
    ).rejects.toThrow(/projects.account_id must be an account/);
  });

  it('never moves a project to another account', async () => {
    await run(
      `INSERT INTO projects (slug, repo, display_name, added_at) VALUES ('g3', 'acme/g3', 'g3', ?1)`,
      T0,
    );
    await expect(run(`UPDATE projects SET account_id = ?1 WHERE slug = 'g3'`, OTHER_ACCOUNT)).rejects.toThrow(
      /projects never change account/,
    );
  });

  it('records a repository id once and keeps it unique per provider', async () => {
    await run(
      `INSERT INTO projects (slug, repo, display_name, added_at) VALUES ('g4', 'acme/g4', 'g4', ?1)`,
      T0,
    );
    await run(
      `INSERT INTO projects (slug, repo, display_name, added_at) VALUES ('g5', 'acme/g5', 'g5', ?1)`,
      T0,
    );
    await run(`UPDATE projects SET repo_id = 501 WHERE slug = 'g4'`);
    await expect(run(`UPDATE projects SET repo_id = 502 WHERE slug = 'g4'`)).rejects.toThrow(
      /projects.repo_id is never changed/,
    );
    await expect(run(`UPDATE projects SET repo_id = 501 WHERE slug = 'g5'`)).rejects.toThrow(/UNIQUE/);
    await expect(run(`UPDATE projects SET repo_id = 0 WHERE slug = 'g5'`)).rejects.toThrow(/CHECK/);
  });

  it('keeps an account that has projects', async () => {
    await expect(run('DELETE FROM accounts WHERE id = ?1', OWNER_ACCOUNT_ID)).rejects.toThrow(
      /an account with projects is not deleted/,
    );
  });

  it.each([
    ['an invalid slug shape', 'Acme', '01M6YSNJ00000000000000000A'],
    ['a trailing hyphen', 'acme-', '01M6YSNJ00000000000000000B'],
    ['a non-ULID id', 'acme2', 'acme2'],
  ])('refuses an account with %s', async (_label, slug, id) => {
    await expect(
      run(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, ?2, 'x', ?3)`, id, slug, T0),
    ).rejects.toThrow(/CHECK/);
  });

  it('refuses a second account with a taken slug', async () => {
    await expect(
      run(
        `INSERT INTO accounts (id, slug, name, created_at) VALUES ('01M6YSNJ00000000000000000C', 'acme', 'x', ?1)`,
        T0,
      ),
    ).rejects.toThrow(/accounts.slug is taken/);
  });

  // Security review of #472: REPLACE deletes the conflicting row without firing DELETE or UPDATE triggers.
  it.each(['INSERT OR REPLACE', 'REPLACE'])('refuses %s over an account, by id or by slug', async (verb) => {
    await expect(
      run(
        `${verb} INTO accounts (id, slug, name, created_at) VALUES (?1, 'acme-new', 'x', ?2)`,
        OTHER_ACCOUNT,
        T0,
      ),
    ).rejects.toThrow(/accounts are never replaced/);
    await expect(
      run(
        `${verb} INTO accounts (id, slug, name, created_at) VALUES ('01M6YSNJ00000000000000000D', 'acme', 'x', ?1)`,
        T0,
      ),
    ).rejects.toThrow(/accounts.slug is taken/);
    expect(
      await env.DB.prepare(`SELECT slug FROM accounts WHERE id = ?1`).bind(OTHER_ACCOUNT).first('slug'),
    ).toBe('acme');
  });

  it.each(['INSERT OR REPLACE', 'REPLACE'])(
    'refuses %s that would move a project to another account or rewrite its repo id',
    async (verb) => {
      const slug = verb === 'REPLACE' ? 'r2' : 'r1';
      await run(
        `INSERT INTO projects (slug, repo, display_name, added_at, repo_id) VALUES (?1, ?2, ?1, ?3, ?4)`,
        slug,
        `acme/${slug}`,
        T0,
        slug === 'r1' ? 701 : 702,
      );
      const replace = (values: { slug: string; repo: string; repoId: number }) =>
        run(
          `${verb} INTO projects (slug, repo, display_name, added_at, account_id, repo_id)
           VALUES (?1, ?2, 'x', ?3, ?4, ?5)`,
          values.slug,
          values.repo,
          T0,
          OTHER_ACCOUNT,
          values.repoId,
        );
      // By the slug, the repository and the repository id.
      await expect(replace({ slug, repo: `acme/${slug}`, repoId: 999 })).rejects.toThrow(
        /projects are never replaced/,
      );
      await expect(replace({ slug: `${slug}-x`, repo: `acme/${slug}`, repoId: 998 })).rejects.toThrow(
        /projects are never replaced/,
      );
      await expect(
        replace({ slug: `${slug}-y`, repo: `acme/${slug}-y`, repoId: slug === 'r1' ? 701 : 702 }),
      ).rejects.toThrow(/projects are never replaced/);
      expect(
        await env.DB.prepare('SELECT account_id, repo_id FROM projects WHERE slug = ?1').bind(slug).first(),
      ).toEqual({ account_id: OWNER_ACCOUNT_ID, repo_id: slug === 'r1' ? 701 : 702 });
    },
  );

  it('refuses entitlements that are not a JSON object', async () => {
    await expect(
      run(`UPDATE accounts SET entitlements = '[1]' WHERE id = ?1`, OTHER_ACCOUNT),
    ).rejects.toThrow(/CHECK/);
    await expect(run(`UPDATE accounts SET entitlements = 'x' WHERE id = ?1`, OTHER_ACCOUNT)).rejects.toThrow(
      /CHECK/,
    );
  });

  it('keeps the last owner of an account, whether removed, demoted or replaced', async () => {
    await expect(run('DELETE FROM account_members WHERE account_id = ?1', OTHER_ACCOUNT)).rejects.toThrow(
      /keeps its last owner/,
    );
    await expect(
      run(`UPDATE account_members SET role = 'member' WHERE account_id = ?1`, OTHER_ACCOUNT),
    ).rejects.toThrow(/keeps its last owner/);
    await expect(
      run(
        `INSERT OR REPLACE INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3)`,
        OTHER_ACCOUNT,
        OTHER_USER,
        T0,
      ),
    ).rejects.toThrow(/a membership is never replaced/);
    await expect(
      run(`UPDATE account_members SET user_id = ?1 WHERE account_id = ?2`, OWNER_USER_ID, OTHER_ACCOUNT),
    ).rejects.toThrow(/changes only its role/);
  });

  it('lets an owner step down once another owner exists', async () => {
    const second = '01M6YSNJ00000000000000000X';
    await run(
      `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
       VALUES (?1, 'github', '3004', 'acme-second', ?2, ?2)`,
      second,
      T0,
    );
    await run(
      `INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`,
      OTHER_ACCOUNT,
      second,
      T0,
    );
    await run(
      `UPDATE account_members SET role = 'member' WHERE account_id = ?1 AND user_id = ?2`,
      OTHER_ACCOUNT,
      second,
    );
    await run('DELETE FROM account_members WHERE account_id = ?1 AND user_id = ?2', OTHER_ACCOUNT, second);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM account_members WHERE account_id = ?1`)
        .bind(OTHER_ACCOUNT)
        .first('n'),
    ).toBe(1);
  });

  it('writes a user identity and its Access link once', async () => {
    await expect(run(`UPDATE users SET provider_user_id = '9' WHERE id = ?1`, OTHER_USER)).rejects.toThrow(
      /keep their identity/,
    );
    await run(`UPDATE users SET access_subject = 'access-sub-1' WHERE id = ?1`, OTHER_USER);
    await expect(
      run(`UPDATE users SET access_subject = 'access-sub-2' WHERE id = ?1`, OTHER_USER),
    ).rejects.toThrow(/written once/);
    await expect(run(`UPDATE users SET access_subject = NULL WHERE id = ?1`, OTHER_USER)).rejects.toThrow(
      /written once/,
    );
    await expect(
      run(
        `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
         VALUES ('01M6YSNJ00000000000000000W', 'github', '3003', 'dup', ?1, ?1)`,
        T0,
      ),
    ).rejects.toThrow(/users are never replaced/);
  });

  it.each(['INSERT OR REPLACE', 'REPLACE'])(
    'refuses %s that would re-key a user or rewrite its Access link',
    async (verb) => {
      const replace = (id: string, providerUserId: string, accessSubject: string | null) =>
        run(
          `${verb} INTO users (id, provider, provider_user_id, login, access_subject, created_at, last_seen_at)
           VALUES (?1, 'github', ?2, 'attacker', ?3, ?4, ?4)`,
          id,
          providerUserId,
          accessSubject,
          T0,
        );
      // Same id, another GitHub user: would hand the user's memberships to GitHub id 777.
      await expect(replace(OTHER_USER, '777', null)).rejects.toThrow(/users are never replaced/);
      // Same GitHub user under a fresh id.
      await expect(replace('01M6YSNJ00000000000000000V', '3003', null)).rejects.toThrow(
        /users are never replaced/,
      );
      // Same Access identity on another row.
      await expect(replace('01M6YSNJ00000000000000000T', '778', 'access-sub-1')).rejects.toThrow(
        /users are never replaced/,
      );
      expect(
        await env.DB.prepare('SELECT provider_user_id, access_subject FROM users WHERE id = ?1')
          .bind(OTHER_USER)
          .first(),
      ).toEqual({ provider_user_id: '3003', access_subject: 'access-sub-1' });
    },
  );

  it('binds owner invites to a login and keeps open invites member-only and short', async () => {
    const insert = (hash: string, role: string, login: string | null, expiresAt: string) =>
      run(
        `INSERT INTO invites (token_hash, account_id, role, login, created_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        hash.repeat(64),
        OTHER_ACCOUNT,
        role,
        login,
        OTHER_USER,
        T0,
        expiresAt,
      );
    await insert('a', 'member', null, '2026-11-12T00:00:00.000Z');
    await insert('b', 'owner', 'someone', '2026-11-30T00:00:00.000Z');
    await expect(insert('c', 'owner', null, '2026-11-10T00:00:00.000Z')).rejects.toThrow(/CHECK/);
    await expect(insert('d', 'member', null, '2026-11-12T00:00:01.000Z')).rejects.toThrow(/CHECK/);
    await expect(insert('e', 'member', null, T0)).rejects.toThrow(/CHECK/);
    await expect(insert('F', 'member', null, '2026-11-10T00:00:00.000Z')).rejects.toThrow(/CHECK/);
  });

  // Security review of #472: julianday('never') is NULL, which a bare CHECK would pass as "never expires".
  it.each([
    'never',
    '2026-11-10',
    '2026-11-10 00:00:00',
    '2026-02-30T00:00:00.000Z',
    '2026-11-10T00:00:00+02:00',
  ])('refuses %j as an invite or session expiry', async (expiresAt) => {
    const hash = (seed: string) => seed.repeat(64);
    await expect(
      run(
        `INSERT INTO invites (token_hash, account_id, role, login, created_by, created_at, expires_at)
           VALUES (?1, ?2, 'member', NULL, ?3, ?4, ?5)`,
        hash('7'),
        OTHER_ACCOUNT,
        OTHER_USER,
        T0,
        expiresAt,
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(
        `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)`,
        hash('8'),
        OTHER_USER,
        T0,
        expiresAt,
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('accepts a session with real UTC timestamps', async () => {
    await run(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)`,
      '9'.repeat(64),
      OTHER_USER,
      T0,
      '2026-12-09T00:00:00Z',
    );
  });

  it('links an installation once while linked and never re-points it', async () => {
    const link = (installationId: string, unlinkedAt: string | null) =>
      run(
        `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_at, unlinked_at)
         VALUES (?1, 'github', ?2, 'acme', ?3, ?4)`,
        OTHER_ACCOUNT,
        installationId,
        T0,
        unlinkedAt,
      );
    await link('900', T0);
    await link('900', null);
    await expect(link('900', null)).rejects.toThrow(/never re-pointed/);
    await expect(link('9a', null)).rejects.toThrow(/CHECK/);
    await expect(
      run(`UPDATE installations SET account_id = ?1 WHERE installation_id = '900'`, OWNER_ACCOUNT_ID),
    ).rejects.toThrow(/never re-pointed/);
  });

  it('never revives an unlinked installation in place', async () => {
    await expect(
      run(
        `UPDATE installations SET unlinked_at = NULL WHERE installation_id = '900' AND unlinked_at IS NOT NULL`,
      ),
    ).rejects.toThrow(/never re-pointed/);
    await expect(
      run(
        `UPDATE installations SET unlinked_at = '2026-12-01T00:00:00.000Z' WHERE installation_id = '900' AND unlinked_at IS NOT NULL`,
      ),
    ).rejects.toThrow(/never re-pointed/);
    // Unlinking a live link is the one change it gets.
    await run(
      `UPDATE installations SET unlinked_at = ?1 WHERE installation_id = '900' AND unlinked_at IS NULL`,
      T0,
    );
  });

  it.each(['INSERT OR REPLACE', 'REPLACE'])(
    'refuses %s that would take over a live installation link',
    async (verb) => {
      const installationId = verb === 'REPLACE' ? '911' : '910';
      await run(
        `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_at)
         VALUES (?1, 'github', ?2, 'owner-login', ?3)`,
        OWNER_ACCOUNT_ID,
        installationId,
        T0,
      );
      const id = await env.DB.prepare(`SELECT id FROM installations WHERE installation_id = ?1`)
        .bind(installationId)
        .first<number>('id');
      // Through the live (provider, installation_id) index, and through the row id.
      await expect(
        run(
          `${verb} INTO installations (account_id, provider, installation_id, account_login, linked_at)
           VALUES (?1, 'github', ?2, 'acme', ?3)`,
          OTHER_ACCOUNT,
          installationId,
          T0,
        ),
      ).rejects.toThrow(/never re-pointed/);
      await expect(
        run(
          `${verb} INTO installations (id, account_id, provider, installation_id, account_login, linked_at)
           VALUES (?1, ?2, 'github', '999999', 'acme', ?3)`,
          id,
          OTHER_ACCOUNT,
          T0,
        ),
      ).rejects.toThrow(/never re-pointed/);
      expect(
        await env.DB.prepare('SELECT account_id, unlinked_at FROM installations WHERE id = ?1')
          .bind(id)
          .first(),
      ).toEqual({ account_id: OWNER_ACCOUNT_ID, unlinked_at: null });
    },
  );

  it('keeps audit_events append-only: no update, no delete, no replace', async () => {
    await run(
      `INSERT INTO audit_events (id, account_id, at, actor_kind, actor, kind) VALUES (9001, ?1, ?2, 'user', ?3, 'auth.signed-in')`,
      OTHER_ACCOUNT,
      T0,
      OTHER_USER,
    );
    await expect(run(`UPDATE audit_events SET actor = 'x' WHERE id = 9001`)).rejects.toThrow(/append-only/);
    await expect(run('DELETE FROM audit_events WHERE id = 9001')).rejects.toThrow(/append-only/);
    await expect(
      run(
        `INSERT OR REPLACE INTO audit_events (id, account_id, at, actor_kind, actor, kind)
         VALUES (9001, ?1, ?2, 'system', 'x', 'auth.signed-out')`,
        OTHER_ACCOUNT,
        T0,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      run(
        `REPLACE INTO audit_events (id, account_id, at, actor_kind, actor, kind)
         VALUES (9001, ?1, ?2, 'system', 'x', 'auth.signed-out')`,
        OTHER_ACCOUNT,
        T0,
      ),
    ).rejects.toThrow(/append-only/);
    expect(await env.DB.prepare('SELECT actor FROM audit_events WHERE id = 9001').first('actor')).toBe(
      OTHER_USER,
    );
  });

  it.each([
    ['a user event without an account', null, 'user', 'auth.signed-in', '{}'],
    ['an unknown actor kind', 'acct', 'owner', 'auth.signed-in', '{}'],
    ['a kind outside the shape', 'acct', 'user', 'Auth Signed In', '{}'],
    ['details that are not an object', 'acct', 'user', 'auth.signed-in', '[]'],
    ['oversized details', 'acct', 'user', 'auth.signed-in', JSON.stringify({ x: 'y'.repeat(4100) })],
    // 2,100 characters but over 4 KiB of UTF-8: the bound counts bytes.
    [
      'details over 4 KiB in bytes',
      'acct',
      'user',
      'auth.signed-in',
      JSON.stringify({ x: 'é'.repeat(2100) }),
    ],
  ])('refuses an audit row with %s', async (_label, account, actorKind, kind, details) => {
    await expect(
      run(
        `INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, details) VALUES (?1, ?2, ?3, 'a', ?4, ?5)`,
        account === null ? null : OTHER_ACCOUNT,
        T0,
        actorKind,
        kind,
        details,
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('admits an operator event without an account', async () => {
    await run(
      `INSERT INTO audit_events (account_id, at, actor_kind, actor, kind) VALUES (NULL, ?1, 'operator', 'ops', 'plan.changed')`,
      T0,
    );
  });
});
