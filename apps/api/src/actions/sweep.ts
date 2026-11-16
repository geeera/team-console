import { ACTIONS_NO_SHOW, ACTIONS_NO_SHOW_MINUTES } from '@shared/contracts';
import type { Logger } from '@worker/core';
import { JobsRepo, TeamStateRepo } from '@worker/db';
import type { ApiEnv } from '../env';

/**
 * The queue's Cron sweep (#670; `triggers.crons` in wrangler.jsonc, every 5 minutes). An Actions-only account has no
 * runner polling the claim route, which is where lapsed leases were swept until now, so the sweep runs them here too:
 * lapsed leases first (an Actions job is lost on its first lapse and its ephemeral identity revoked), then every
 * Actions job no run exchanged a token for within `ACTIONS_NO_SHOW_MINUTES` fails as `actions-no-show`.
 */
export async function sweepQueue(env: Pick<ApiEnv, 'DB'>, now: Date, logger: Logger): Promise<void> {
  const at = now.toISOString();
  const jobs = new JobsRepo(env.DB);
  const lapsed = await jobs.requeueLapsed(at);
  const teamState = new TeamStateRepo(env.DB);
  for (const lost of lapsed.lost) {
    await teamState.recordOutcome(lost.projectSlug, 'failed', at);
  }
  const noShows = await jobs.failActionsNoShows(at, ACTIONS_NO_SHOW_MINUTES, ACTIONS_NO_SHOW);
  if (lapsed.requeued.length + lapsed.lost.length + noShows.length > 0) {
    logger.info('queue swept', {
      requeued: lapsed.requeued.length,
      lost: lapsed.lost.length,
      noShows: noShows.length,
    });
  }
}
