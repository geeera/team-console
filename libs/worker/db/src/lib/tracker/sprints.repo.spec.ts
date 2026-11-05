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
      true,
    );
    expect(await sprints().create(slug, 2, { dueOn: null, description: '', at: AT })).toBe(true);
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
    await expect(sprints().findByNumber(other.slug, 1)).resolves.toBeNull();
  });

  it('answers false for a number another request took, writing nothing else in the batch', async () => {
    const { slug } = await seedTrackerProject();
    await sprints().create(slug, 1, { dueOn: null, description: '', at: AT });
    const marker = env.DB.prepare(
      "INSERT INTO idempotency_keys (key, request_hash, created_at, expires_at) VALUES ('sprint-race', 'h', ?1, 0)",
    ).bind(AT);
    expect(await sprints().create(slug, 1, { dueOn: null, description: '', at: AT }, [marker])).toBe(false);
    await expect(
      env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = 'sprint-race'").first(),
    ).resolves.toBeNull();
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
