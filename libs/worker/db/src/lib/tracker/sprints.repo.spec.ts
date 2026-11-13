import { env } from 'cloudflare:test';
import { AT, seedTrackerProject } from '../../testing/tracker-kit';
import { SprintsRepo } from './sprints.repo';

const sprints = (): SprintsRepo => new SprintsRepo(env.DB);
const LATER = '2026-11-18T09:00:00.000Z';

describe('SprintsRepo', () => {
  it('numbers sprints per project and titles them Sprint NN', async () => {
    const { slug } = await seedTrackerProject();
    const other = await seedTrackerProject();
    await expect(sprints().nextNumber(slug)).resolves.toBe(1);
    expect(await sprints().create(slug, 1, { dueOn: '2026-11-17', description: 'Tracker', at: AT })).toBe(
      'created',
    );
    expect(await sprints().create(slug, 2, { dueOn: null, description: '', at: AT })).toBe('created');
    await expect(sprints().nextNumber(slug)).resolves.toBe(3);
    await expect(sprints().nextNumber(other.slug)).resolves.toBe(1);
    await expect(sprints().findByNumber(slug, 1)).resolves.toMatchObject({
      number: 1,
      title: 'Sprint 01',
      dueOn: '2026-11-17',
      state: 'open',
      description: 'Tracker',
      createdAt: AT,
      closedAt: null,
    });
    await expect(sprints().list(slug, 'all')).resolves.toHaveLength(2);
    await expect(sprints().findByNumber(slug, 2)).resolves.toMatchObject({ title: 'Sprint 02' });
    await expect(sprints().findByNumber(other.slug, 1)).resolves.toBeNull();
  });

  it('answers number-taken for a number another request took, writing nothing else in the batch', async () => {
    const { slug } = await seedTrackerProject();
    await sprints().create(slug, 1, { dueOn: null, description: '', at: AT });
    const marker = env.DB.prepare(
      "INSERT INTO idempotency_keys (key, request_hash, created_at, expires_at) VALUES ('sprint-race', 'h', ?1, 0)",
    ).bind(AT);
    expect(await sprints().create(slug, 1, { dueOn: null, description: '', at: AT }, [marker])).toBe(
      'number-taken',
    );
    await expect(
      env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = 'sprint-race'").first(),
    ).resolves.toBeNull();
  });

  it("titles a sprint with the owner's name when one is given (#457)", async () => {
    const { slug } = await seedTrackerProject();
    await sprints().create(slug, 1, { dueOn: null, description: '', title: 'Checkout', at: AT });
    await sprints().create(slug, 2, { dueOn: null, description: '', title: null, at: AT });
    const titles = (await sprints().list(slug, 'all')).map((sprint) => sprint.title);
    expect(titles).toEqual(['Checkout', 'Sprint 02']);
  });

  it('finds a sprint by its title ignoring case, within its project only (#545)', async () => {
    const { slug } = await seedTrackerProject();
    const other = await seedTrackerProject();
    await sprints().create(slug, 1, { dueOn: null, description: '', title: 'Спринт Альфа', at: AT });
    await sprints().create(slug, 2, { dueOn: null, description: '', at: AT });
    await expect(sprints().findByTitle(slug, 'спринт альфа')).resolves.toMatchObject({ number: 1 });
    await expect(sprints().findByTitle(slug, 'SPRINT 02')).resolves.toMatchObject({ number: 2 });
    await expect(sprints().findByTitle(slug, 'Sprint 03')).resolves.toBeNull();
    await expect(sprints().findByTitle(other.slug, 'Спринт Альфа')).resolves.toBeNull();
  });

  it('answers title-taken for a title another sprint of the project has, writing nothing else (#545)', async () => {
    const { slug } = await seedTrackerProject();
    const other = await seedTrackerProject();
    await sprints().create(slug, 1, { dueOn: null, description: '', title: 'Checkout', at: AT });
    const marker = env.DB.prepare(
      "INSERT INTO idempotency_keys (key, request_hash, created_at, expires_at) VALUES ('title-race', 'h', ?1, 0)",
    ).bind(AT);
    expect(
      await sprints().create(slug, 2, { dueOn: null, description: '', title: 'CHECKOUT', at: AT }, [marker]),
    ).toBe('title-taken');
    await expect(
      env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = 'title-race'").first(),
    ).resolves.toBeNull();
    await expect(sprints().nextNumber(slug)).resolves.toBe(2);
    // A default name collides like any other: sprint 3 would be `Sprint 03`, which sprint 2 already holds.
    await sprints().create(slug, 2, { dueOn: null, description: '', title: 'Sprint 03', at: AT });
    expect(await sprints().create(slug, 3, { dueOn: null, description: '', at: AT })).toBe('title-taken');
    expect(
      await sprints().create(other.slug, 1, { dueOn: null, description: '', title: 'checkout', at: AT }),
    ).toBe('created');
  });

  it('closes and reopens a sprint, changing only the fields it is given', async () => {
    const { slug } = await seedTrackerProject();
    await sprints().create(slug, 1, { dueOn: '2026-11-17', description: 'Keep', at: AT });
    await expect(sprints().update(slug, 1, { state: 'closed' }, LATER)).resolves.toMatchObject({
      state: 'closed',
      closedAt: LATER,
      dueOn: '2026-11-17',
      description: 'Keep',
    });
    await expect(sprints().list(slug, 'open')).resolves.toEqual([]);
    await expect(sprints().update(slug, 1, { state: 'open', dueOn: null }, LATER)).resolves.toMatchObject({
      state: 'open',
      closedAt: null,
      dueOn: null,
    });
    await expect(sprints().update(slug, 9, { state: 'closed' }, LATER)).resolves.toBeNull();
  });
});
