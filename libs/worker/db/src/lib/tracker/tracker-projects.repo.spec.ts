import { env } from 'cloudflare:test';
import { AT, seedGitHubProject, seedTrackerProject } from '../../testing/tracker-kit';
import { LABELS_SEED } from './labels-seed';
import { LabelsRepo } from './labels.repo';
import { TrackerProjectsRepo } from './tracker-projects.repo';

const repo = (): TrackerProjectsRepo => new TrackerProjectsRepo(env.DB);

describe('TrackerProjectsRepo', () => {
  it('reads a registered project as still on GitHub Issues', async () => {
    const slug = await seedGitHubProject();
    await expect(repo().find(slug)).resolves.toEqual({
      slug,
      tracker: 'github',
      keyPrefix: null,
      nextItemNumber: 1,
      cutoverAt: null,
    });
    await expect(repo().find('nope')).resolves.toBeNull();
  });

  it('allocates no number while the project is on GitHub Issues, or for an unknown one', async () => {
    const slug = await seedGitHubProject();
    await expect(repo().allocateItemNumber(slug)).resolves.toBeNull();
    await expect(repo().allocateItemNumber('nope')).resolves.toBeNull();
    await expect(repo().find(slug)).resolves.toMatchObject({ nextItemNumber: 1 });
  });

  it('never hands the same number to two creates arriving together', async () => {
    const { slug } = await seedTrackerProject(412);
    const numbers = await Promise.all(Array.from({ length: 8 }, () => repo().allocateItemNumber(slug)));
    expect(new Set(numbers).size).toBe(8);
    expect([...numbers].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      412, 413, 414, 415, 416, 417, 418, 419,
    ]);
    await expect(repo().find(slug)).resolves.toMatchObject({ nextItemNumber: 420 });
  });

  it('switches to the console with the builtin labels, keeping custom ones and never lowering the next number', async () => {
    const { slug } = await seedTrackerProject(50);
    await new LabelsRepo(env.DB).create(slug, { name: 'agent:dev', color: 'ededed', description: '' });
    expect(
      await repo().switchTracker(slug, { tracker: 'console', keyPrefix: 'ZZ', nextItemNumber: 10, at: AT }),
    ).toBe(true);
    await expect(repo().find(slug)).resolves.toMatchObject({
      tracker: 'console',
      keyPrefix: 'ZZ',
      nextItemNumber: 50,
      cutoverAt: AT,
    });
    const labels = await new LabelsRepo(env.DB).list(slug);
    expect(labels.filter((label) => label.builtin)).toHaveLength(LABELS_SEED.length);
    expect(labels.find((label) => label.name === 'agent:dev')).toMatchObject({ builtin: false });
  });

  it('refuses a tracker off GitHub without a key prefix, a malformed prefix and a prefix taken by another project', async () => {
    const slug = await seedGitHubProject();
    const set = (tracker: string, prefix: string | null) =>
      env.DB.prepare('UPDATE projects SET tracker = ?2, key_prefix = ?3 WHERE slug = ?1')
        .bind(slug, tracker, prefix)
        .run();
    await expect(set('console', null)).rejects.toThrow(/CHECK constraint failed/);
    await expect(set('console', 'tc')).rejects.toThrow(/CHECK constraint failed/);
    await expect(set('console', 'TOOLONG')).rejects.toThrow(/CHECK constraint failed/);
    await expect(set('elsewhere', 'AB')).rejects.toThrow(/CHECK constraint failed/);
    const { keyPrefix } = await seedTrackerProject();
    await expect(set('console', keyPrefix)).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
