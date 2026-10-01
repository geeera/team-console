import { env } from 'cloudflare:test';
import { ProjectSignalsRepo } from './project-signals.repo';

const signals = new ProjectSignalsRepo(env.DB);

async function seed(slug: string, repo: string): Promise<void> {
  await env.DB.prepare('INSERT INTO projects (slug, repo, display_name, added_at) VALUES (?1, ?2, ?1, ?3)')
    .bind(slug, repo, '2026-09-30T00:00:00Z')
    .run();
}

async function deliver(id: string, event: string, repo: string, receivedAt: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO webhook_deliveries (delivery_id, event, repo, body_sha256, received_at) VALUES (?1, ?2, ?3, ?1, ?4)',
  )
    .bind(id, event, repo, receivedAt)
    .run();
}

describe('eventsFor', () => {
  it('is unseen before any delivery, then the latest delivery of the repository in any case', async () => {
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: false,
      lastEventAt: null,
    });

    await deliver('d-1', 'issues', 'Geeera/Team-Console', '2026-09-30T00:00:00Z');
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: true,
      lastEventAt: '2026-09-30T00:00:00Z',
    });
    await expect(signals.eventsFor('geeera/other')).resolves.toEqual({ seen: false, lastEventAt: null });

    await deliver('d-2', 'push', 'geeera/team-console', '2026-09-30T05:00:00Z');
    await expect(signals.eventsFor('geeera/team-console')).resolves.toEqual({
      seen: true,
      lastEventAt: '2026-09-30T05:00:00Z',
    });
  });
});

describe('accessLostAt', () => {
  it('is null until access is lost, then the time; null for an unknown slug', async () => {
    await seed('after', 'acme/after');
    await expect(signals.accessLostAt('after')).resolves.toBeNull();

    await env.DB.prepare('UPDATE projects SET access_lost_at = ?1 WHERE slug = ?2')
      .bind('2026-09-30T10:00:00Z', 'after')
      .run();
    await expect(signals.accessLostAt('after')).resolves.toBe('2026-09-30T10:00:00Z');
    await expect(signals.accessLostAt('unknown')).resolves.toBeNull();
  });
});
