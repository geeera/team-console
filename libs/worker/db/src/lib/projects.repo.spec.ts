import { env } from 'cloudflare:test';
import { ProjectsRepo, toProjectDto } from './projects.repo';

interface Seed {
  slug: string;
  repo: string;
  displayName: string;
  addedAt: string;
  archivedAt?: string;
}

async function seed(project: Seed): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, added_at, archived_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(project.slug, project.repo, project.displayName, project.addedAt, project.archivedAt ?? null)
    .run();
}

describe('ProjectsRepo', () => {
  const repo = new ProjectsRepo(env.DB);

  it('lists nothing on a fresh database', async () => {
    await expect(repo.listActive()).resolves.toEqual([]);
  });

  it('lists active projects in registration order and skips archived ones', async () => {
    await seed({ slug: 'later', repo: 'acme/later', displayName: 'Later', addedAt: '2026-09-02T00:00:00Z' });
    await seed({ slug: 'first', repo: 'acme/first', displayName: 'First', addedAt: '2026-09-01T00:00:00Z' });
    await seed({
      slug: 'gone',
      repo: 'acme/gone',
      displayName: 'Gone',
      addedAt: '2026-08-01T00:00:00Z',
      archivedAt: '2026-09-10T00:00:00Z',
    });

    const rows = await repo.listActive();

    expect(rows.map((row) => row.slug)).toEqual(['first', 'later']);
    expect(rows[0]).toEqual({
      slug: 'first',
      repo: 'acme/first',
      display_name: 'First',
      routine_id: null,
      cache_epoch: 0,
      added_at: '2026-09-01T00:00:00Z',
      archived_at: null,
    });
  });

  it('finds an active project by repository, ignoring case', async () => {
    await seed({
      slug: 'tc',
      repo: 'geeera/team-console',
      displayName: 'Team Console',
      addedAt: '2026-09-01T00:00:00Z',
    });

    await expect(repo.findActiveByRepo('Geeera/Team-Console')).resolves.toMatchObject({ slug: 'tc' });
    await expect(repo.findActiveByRepo('geeera/other')).resolves.toBeNull();
  });

  // D1 storage is shared by the tests of this file, so these rows use names no other test seeds.
  it('finds an active project by slug and not an archived one', async () => {
    await seed({
      slug: 'by-slug',
      repo: 'acme/by-slug',
      displayName: 'By slug',
      addedAt: '2026-09-01T00:00:00Z',
    });
    await seed({
      slug: 'by-slug-archived',
      repo: 'acme/by-slug-archived',
      displayName: 'Archived',
      addedAt: '2026-09-01T00:00:00Z',
      archivedAt: '2026-09-02T00:00:00Z',
    });

    await expect(repo.findActiveBySlug('by-slug')).resolves.toMatchObject({ repo: 'acme/by-slug' });
    await expect(repo.findActiveBySlug('by-slug-archived')).resolves.toBeNull();
    await expect(repo.findActiveBySlug('BY-SLUG')).resolves.toBeNull();
  });

  it('does not find an archived project by repository', async () => {
    await seed({
      slug: 'old',
      repo: 'acme/old',
      displayName: 'Old',
      addedAt: '2026-09-01T00:00:00Z',
      archivedAt: '2026-09-02T00:00:00Z',
    });

    await expect(repo.findActiveByRepo('acme/old')).resolves.toBeNull();
  });

  it('enforces the unique repository constraint from the migration', async () => {
    await seed({ slug: 'a', repo: 'acme/dup', displayName: 'A', addedAt: '2026-09-01T00:00:00Z' });

    await expect(
      seed({ slug: 'b', repo: 'acme/dup', displayName: 'B', addedAt: '2026-09-01T00:00:00Z' }),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe('toProjectDto', () => {
  it('exposes only the client-facing fields', () => {
    expect(
      toProjectDto({
        slug: 'tc',
        repo: 'geeera/team-console',
        display_name: 'Team Console',
        routine_id: 'trig_123',
        cache_epoch: 4,
        added_at: '2026-09-01T00:00:00Z',
        archived_at: null,
      }),
    ).toEqual({
      slug: 'tc',
      repo: 'geeera/team-console',
      displayName: 'Team Console',
      addedAt: '2026-09-01T00:00:00Z',
    });
  });
});
