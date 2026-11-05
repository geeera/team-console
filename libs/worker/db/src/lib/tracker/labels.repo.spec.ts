import { env } from 'cloudflare:test';
import { seedGitHubProject, seedTrackerProject } from '../../testing/tracker-kit';
import { LABELS_SEED } from './labels-seed';
import { LabelsRepo } from './labels.repo';

const labels = (): LabelsRepo => new LabelsRepo(env.DB);

describe('LabelsRepo', () => {
  it('lists builtin labels first, then custom ones', async () => {
    const { slug } = await seedTrackerProject();
    expect(
      await labels().create(slug, { name: 'agent:dev', color: 'ededed', description: 'Dev agent' }),
    ).toBe(true);
    const listed = await labels().list(slug);
    expect(listed).toHaveLength(LABELS_SEED.length + 1);
    expect(listed.at(-1)).toEqual({
      name: 'agent:dev',
      color: 'ededed',
      description: 'Dev agent',
      builtin: false,
    });
    await expect(labels().find(slug, 'security')).resolves.toMatchObject({ builtin: true, color: 'b60205' });
    await expect(labels().list(await seedGitHubProject())).resolves.toEqual([]);
  });

  it('answers false for a name the project already has, builtin or custom, and writes nothing else', async () => {
    const { slug } = await seedTrackerProject();
    const marker = env.DB.prepare(
      "INSERT INTO idempotency_keys (key, request_hash, created_at, expires_at) VALUES ('label-race', 'h', 'x', 0)",
    );
    expect(
      await labels().create(slug, { name: 'security', color: '000000', description: '' }, [marker]),
    ).toBe(false);
    await expect(labels().find(slug, 'security')).resolves.toMatchObject({ builtin: true, color: 'b60205' });
    await expect(
      env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = 'label-race'").first(),
    ).resolves.toBeNull();
  });

  it('names the labels a project does not have, in one query', async () => {
    const { slug } = await seedTrackerProject();
    await expect(
      labels().missing(slug, ['security', 'nope', 'design:approved', 'also-nope']),
    ).resolves.toEqual(['nope', 'also-nope']);
    await expect(labels().missing(slug, [])).resolves.toEqual([]);
  });

  it('refuses a malformed colour', async () => {
    const { slug } = await seedTrackerProject();
    await expect(labels().create(slug, { name: 'x', color: 'GGGGGG', description: '' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });
});
