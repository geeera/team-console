import { env } from 'cloudflare:test';
import { ProjectSignalsRepo } from './project-signals.repo';

// #12's migration does not exist yet: these tests create its table and column by hand to prove both states.

const signals = new ProjectSignalsRepo(env.DB);

async function seed(slug: string, repo: string): Promise<void> {
  await env.DB.prepare('INSERT INTO projects (slug, repo, display_name, added_at) VALUES (?1, ?2, ?1, ?3)')
    .bind(slug, repo, '2026-09-30T00:00:00Z')
    .run();
}

describe('eventsFor', () => {
  afterEach(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS webhook_deliveries').run();
  });

  it('is unseen while webhook_deliveries does not exist', async () => {
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: false,
      lastEventAt: null,
    });
  });

  it('reads the table once it exists, matching the repository case-insensitively', async () => {
    await env.DB.prepare(
      'CREATE TABLE webhook_deliveries (delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, repo TEXT NOT NULL, received_at TEXT NOT NULL)',
    ).run();
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: false,
      lastEventAt: null,
    });

    await env.DB.prepare('INSERT INTO webhook_deliveries VALUES (?1, ?2, ?3, ?4)')
      .bind('d-1', 'issues', 'Geeera/Team-Console', '2026-09-30T00:00:00Z')
      .run();
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: true,
      lastEventAt: '2026-09-30T00:00:00Z',
    });
    await expect(signals.eventsFor('geeera/other')).resolves.toEqual({ seen: false, lastEventAt: null });

    await env.DB.prepare('INSERT INTO webhook_deliveries VALUES (?1, ?2, ?3, ?4)')
      .bind('d-2', 'push', 'geeera/team-console', '2026-09-30T05:00:00Z')
      .run();
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: true,
      lastEventAt: '2026-09-30T05:00:00Z',
    });
  });
});

describe('accessLostAt', () => {
  it('is null while projects has no access_lost_at column', async () => {
    await seed('before', 'acme/before');
    await expect(signals.accessLostAt('before')).resolves.toBeNull();
  });

  it('reads the column once it exists', async () => {
    await seed('after', 'acme/after');
    await env.DB.prepare('ALTER TABLE projects ADD COLUMN access_lost_at TEXT').run();
    await expect(signals.accessLostAt('after')).resolves.toBeNull();

    await env.DB.prepare('UPDATE projects SET access_lost_at = ?1 WHERE slug = ?2')
      .bind('2026-09-30T10:00:00Z', 'after')
      .run();
    await expect(signals.accessLostAt('after')).resolves.toBe('2026-09-30T10:00:00Z');
    await expect(signals.accessLostAt('unknown')).resolves.toBeNull();
  });
});
