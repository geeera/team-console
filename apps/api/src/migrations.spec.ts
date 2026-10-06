import { env } from 'cloudflare:test';

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
      'd1_migrations',
      'own_write_claims',
      'own_writes',
      'owner_connections',
      'projects',
      'push_subscriptions',
      'push_test_sends',
      'slot_requests',
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
    ]);
    expect(results.filter((column) => column.notnull === 1).map((column) => column.name)).toEqual([
      'repo',
      'display_name',
      'cache_epoch',
      'added_at',
      'snooze_allows_urgent',
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
});
