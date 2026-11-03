import { env } from 'cloudflare:test';
import { ProjectsRepo, isSnoozedAt, snoozeOf, toProjectDto, type ProjectRow } from './projects.repo';

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
      installation_id: null,
      snoozed_at: null,
      snoozed_until: null,
      snooze_allows_urgent: 1,
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

describe('ProjectsRepo writes (#15)', () => {
  const repo = new ProjectsRepo(env.DB);
  const project = (slug: string, name: string) => ({
    slug,
    repo: `acme/${name}`,
    displayName: name,
    installationId: 1001,
    addedAt: '2026-09-30T00:00:00Z',
  });

  it('creates a row with its installation id', async () => {
    await expect(repo.create(project('w-new', 'w-new'))).resolves.toBe(true);
    await expect(repo.findActiveBySlug('w-new')).resolves.toMatchObject({
      repo: 'acme/w-new',
      installation_id: 1001,
      cache_epoch: 0,
      archived_at: null,
      routine_id: null,
    });
  });

  it('refuses a second row with the slug or the repository (any case), archived rows included', async () => {
    await repo.create(project('w-dup', 'w-dup'));
    await expect(repo.create(project('w-dup', 'w-other'))).resolves.toBe(false);
    await expect(repo.create({ ...project('w-dup2', 'x'), repo: 'ACME/W-DUP' })).resolves.toBe(false);
    await expect(repo.findConflict('w-dup2', 'Acme/W-Dup')).resolves.toEqual({
      slug: 'w-dup',
      archived: false,
    });

    await repo.archive('w-dup', '2026-09-30T01:00:00Z');
    await expect(repo.create(project('w-dup3', 'w-dup'))).resolves.toBe(false);
    await expect(repo.findConflict('w-dup', 'acme/unrelated')).resolves.toEqual({
      slug: 'w-dup',
      archived: true,
    });
    await expect(repo.findConflict('w-free', 'acme/w-free')).resolves.toBeNull();
  });

  it('updates the display name and the routine id independently, and clears the routine id with null', async () => {
    await repo.create(project('w-upd', 'w-upd'));

    await expect(repo.update('w-upd', { routineId: 'trig_abc' })).resolves.toMatchObject({
      display_name: 'w-upd',
      routine_id: 'trig_abc',
    });
    await expect(repo.update('w-upd', { displayName: 'Renamed' })).resolves.toMatchObject({
      display_name: 'Renamed',
      routine_id: 'trig_abc',
    });
    await expect(repo.update('w-upd', { routineId: null })).resolves.toMatchObject({
      display_name: 'Renamed',
      routine_id: null,
    });
    await expect(repo.update('w-nope', { displayName: 'x' })).resolves.toBeNull();
  });

  it('archives an active project once and then neither updates nor lists it as active', async () => {
    await repo.create(project('w-arc', 'w-arc'));
    await expect(repo.archive('w-arc', '2026-09-30T02:00:00Z')).resolves.toBe(true);
    await expect(repo.archive('w-arc', '2026-09-30T03:00:00Z')).resolves.toBe(false);
    await expect(repo.update('w-arc', { displayName: 'x' })).resolves.toBeNull();
    expect((await repo.listActive()).map((row) => row.slug)).not.toContain('w-arc');

    const all = await repo.listAll();
    const archived = all.find((row) => row.slug === 'w-arc');
    expect(archived?.archived_at).toBe('2026-09-30T02:00:00Z');
    // Archived rows come after every active one.
    const firstArchived = all.findIndex((row) => row.archived_at !== null);
    expect(all.slice(firstArchived).every((row) => row.archived_at !== null)).toBe(true);
  });
});

describe('ProjectsRepo webhook writes (#12)', () => {
  const repo = new ProjectsRepo(env.DB);

  async function accessLostAt(slug: string): Promise<string | null | undefined> {
    const row = await env.DB.prepare('SELECT access_lost_at FROM projects WHERE slug = ?1')
      .bind(slug)
      .first<{ access_lost_at: string | null }>();
    return row?.access_lost_at;
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM projects').run();
    for (const [slug, installationId] of [
      ['h-one', 2001],
      ['h-two', 2001],
      ['h-other', 2002],
    ] as const) {
      await repo.create({
        slug,
        repo: `acme/${slug}`,
        displayName: slug,
        installationId,
        addedAt: '2026-10-01T00:00:00Z',
      });
    }
  });

  it('bumps the cache epoch of one project', async () => {
    await repo.bumpCacheEpoch('h-one');
    await repo.bumpCacheEpoch('h-one');
    await expect(repo.findActiveBySlug('h-one')).resolves.toMatchObject({ cache_epoch: 2 });
    await expect(repo.findActiveBySlug('h-two')).resolves.toMatchObject({ cache_epoch: 0 });
  });

  it('marks access lost by repository (any case) and installation, once', async () => {
    const changed = await repo.markAccessLost('ACME/H-One', 2001, '2026-10-01T10:00:00Z');
    expect(changed.map((row) => row.slug)).toEqual(['h-one']);
    expect(await accessLostAt('h-one')).toBe('2026-10-01T10:00:00Z');

    await expect(repo.markAccessLost('acme/h-one', 2001, '2026-10-01T11:00:00Z')).resolves.toEqual([]);
    expect(await accessLostAt('h-one')).toBe('2026-10-01T10:00:00Z');
  });

  it('does not mark a project of another installation or an archived one', async () => {
    await expect(repo.markAccessLost('acme/h-other', 2001, '2026-10-01T10:00:00Z')).resolves.toEqual([]);
    await repo.archive('h-two', '2026-10-01T09:00:00Z');
    await expect(repo.markAccessLost('acme/h-two', 2001, '2026-10-01T10:00:00Z')).resolves.toEqual([]);
    expect(await accessLostAt('h-other')).toBeNull();
    expect(await accessLostAt('h-two')).toBeNull();
  });

  it('marks every active project of a deleted installation', async () => {
    const changed = await repo.markInstallationLost(2001, '2026-10-01T10:00:00Z');
    expect(changed.map((row) => row.slug).sort()).toEqual(['h-one', 'h-two']);
    expect(await accessLostAt('h-other')).toBeNull();
  });

  it('clears access lost for the same installation only', async () => {
    await repo.markAccessLost('acme/h-one', 2001, '2026-10-01T10:00:00Z');
    await expect(repo.clearAccessLost('acme/h-one', 2002)).resolves.toEqual([]);
    const cleared = await repo.clearAccessLost('Acme/h-one', 2001);
    expect(cleared.map((row) => row.slug)).toEqual(['h-one']);
    expect(await accessLostAt('h-one')).toBeNull();
  });
});

const ROW: ProjectRow = {
  slug: 'tc',
  repo: 'geeera/team-console',
  display_name: 'Team Console',
  routine_id: 'trig_123',
  cache_epoch: 4,
  added_at: '2026-09-01T00:00:00Z',
  archived_at: null,
  installation_id: 1001,
  snoozed_at: null,
  snoozed_until: null,
  snooze_allows_urgent: 1,
};
const NOW = Date.parse('2026-10-05T12:00:00Z');

describe('toProjectDto', () => {
  it('exposes only the client-facing fields (no cache epoch, no installation id)', () => {
    expect(toProjectDto(ROW, NOW)).toEqual({
      slug: 'tc',
      repo: 'geeera/team-console',
      displayName: 'Team Console',
      routineId: 'trig_123',
      addedAt: '2026-09-01T00:00:00Z',
      archivedAt: null,
      snooze: { snoozed: false },
    });
  });
});

describe('ProjectsRepo snooze (#221)', () => {
  const repo = new ProjectsRepo(env.DB);

  beforeAll(async () => {
    await seed({ slug: 's-one', repo: 'acme/s-one', displayName: 'One', addedAt: '2026-09-01T00:00:00Z' });
    await seed({
      slug: 's-gone',
      repo: 'acme/s-gone',
      displayName: 'Gone',
      addedAt: '2026-09-01T00:00:00Z',
      archivedAt: '2026-09-02T00:00:00Z',
    });
  });

  it('round-trips a snooze with an end and urgent ones muted', async () => {
    const row = await repo.setSnooze(
      's-one',
      { until: '2026-10-05T13:00:00.000Z', allowsUrgent: false },
      '2026-10-05T12:00:00.000Z',
    );
    expect(row).toMatchObject({
      snoozed_at: '2026-10-05T12:00:00.000Z',
      snoozed_until: '2026-10-05T13:00:00.000Z',
      snooze_allows_urgent: 0,
    });
    const read = await repo.findActiveBySlug('s-one');
    expect(read === null ? null : snoozeOf(read, NOW)).toEqual({
      snoozed: true,
      until: '2026-10-05T13:00:00.000Z',
      allowsUrgent: false,
      since: '2026-10-05T12:00:00.000Z',
    });
  });

  it('round-trips "until turned back on", replacing the previous snooze', async () => {
    await repo.setSnooze(
      's-one',
      { until: '2026-10-05T13:00:00.000Z', allowsUrgent: false },
      '2026-10-05T11:00:00.000Z',
    );
    await repo.setSnooze('s-one', { until: null, allowsUrgent: true }, '2026-10-05T12:00:00.000Z');
    await expect(repo.findActiveBySlug('s-one')).resolves.toMatchObject({
      snoozed_at: '2026-10-05T12:00:00.000Z',
      snoozed_until: null,
      snooze_allows_urgent: 1,
    });
  });

  it('clears the snooze, twice without harm', async () => {
    await repo.setSnooze('s-one', { until: null, allowsUrgent: false }, '2026-10-05T12:00:00.000Z');
    await expect(repo.clearSnooze('s-one')).resolves.toMatchObject({
      snoozed_at: null,
      snoozed_until: null,
      snooze_allows_urgent: 1,
    });
    await expect(repo.clearSnooze('s-one')).resolves.toMatchObject({ snoozed_at: null });
  });

  it('touches no archived or unknown project', async () => {
    const change = { until: null, allowsUrgent: true };
    await expect(repo.setSnooze('s-gone', change, '2026-10-05T12:00:00.000Z')).resolves.toBeNull();
    await expect(repo.setSnooze('nope', change, '2026-10-05T12:00:00.000Z')).resolves.toBeNull();
    await expect(repo.clearSnooze('s-gone')).resolves.toBeNull();
  });
});

describe('isSnoozedAt / snoozeOf', () => {
  const snoozed = (until: string | null): ProjectRow => ({
    ...ROW,
    snoozed_at: '2026-10-05T11:00:00.000Z',
    snoozed_until: until,
  });

  it('mutes until turned back on and until a time still ahead', () => {
    expect(isSnoozedAt(snoozed(null), NOW)).toBe(true);
    expect(isSnoozedAt(snoozed('2026-10-05T12:00:01.000Z'), NOW)).toBe(true);
    expect(snoozeOf(snoozed(null), NOW)).toEqual({
      snoozed: true,
      until: null,
      allowsUrgent: true,
      since: '2026-10-05T11:00:00.000Z',
    });
  });

  it('stops muting once the end has passed, with the row left as it was (no cleanup)', () => {
    const expired = snoozed('2026-10-05T12:00:00.000Z');
    expect(isSnoozedAt(expired, NOW)).toBe(false);
    expect(snoozeOf(expired, NOW)).toEqual({ snoozed: false });
    expect(isSnoozedAt(ROW, NOW)).toBe(false);
  });
});
