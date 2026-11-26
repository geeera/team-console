import { env } from 'cloudflare:test';
import { cancelJobsInFlight, enqueueJob, seedClaimedJob } from '../testing/runner-kit';
import { seedTrackerProject } from '../testing/tracker-kit';
import { liveOrchestratorParentOf, type JobActor } from './parent-job';

// The lineage rule of #612, moved out of `routes/pull-requests.ts` for `…/jobs/:id/children` (#1039): the same
// behaviour, read by both routes. The routes' own refusals are proven in pr-reviews.spec.ts and orchestration.spec.ts.

const actorOf = (jobId: string, projectSlug: string): JobActor => ({
  kind: 'job',
  role: 'orchestrator',
  projectSlug,
  jobId,
  items: [],
});

beforeEach(async () => {
  await cancelJobsInFlight();
});

describe('liveOrchestratorParentOf', () => {
  it('answers the claimed orchestrator job the identity names', async () => {
    const { slug } = await seedTrackerProject();
    const { jobId } = await seedClaimedJob(slug);
    expect(await liveOrchestratorParentOf(env.DB, actorOf(jobId, slug), slug)).toMatchObject({
      id: jobId,
      role: 'orchestrator',
      state: 'claimed',
    });
  });

  it.each<[string, (slug: string) => Promise<string>]>([
    ['no job at all', async () => '01M6YSNJ00000000000000J0X1'],
    ['a queued job nobody claimed', async (slug) => enqueueJob(slug)],
    [
      'a job that finished',
      async (slug) => {
        const { jobId } = await seedClaimedJob(slug);
        await env.DB.prepare(
          `UPDATE jobs SET state = 'finished', finished_at = ?2, token_hash = NULL, lease_until = NULL WHERE id = ?1`,
        )
          .bind(jobId, '2026-11-26T10:00:00.000Z')
          .run();
        return jobId;
      },
    ],
    ['a claimed job of another role', async (slug) => (await seedClaimedJob(slug, 'chat')).jobId],
  ])('answers null for %s', async (_, parentOf) => {
    const { slug } = await seedTrackerProject();
    const jobId = await parentOf(slug);
    expect(await liveOrchestratorParentOf(env.DB, actorOf(jobId, slug), slug)).toBeNull();
  });

  it('answers null for a live orchestrator job of another project', async () => {
    const own = await seedTrackerProject();
    const other = await seedTrackerProject();
    const { jobId } = await seedClaimedJob(other.slug);
    expect(await liveOrchestratorParentOf(env.DB, actorOf(jobId, own.slug), own.slug)).toBeNull();
  });
});
