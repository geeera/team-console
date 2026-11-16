import { ACTIONS_NO_SHOW, ACTIONS_NO_SHOW_MINUTES } from '@shared/contracts';
import type { Logger } from '@worker/core';
import { JobsRepo, TeamStateRepo } from '@worker/db';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { dispatchAdmittedActionsJobs } from './dispatch';

/**
 * The most runs one sweep starts: each dispatch costs up to four GitHub subrequests (repository read, token mint,
 * `workflow_dispatch`, token revoke), and a Cron invocation has 50 on the free plan. The rest wait for the next sweep.
 */
export const SWEEP_DISPATCH_MAX = 8;

/**
 * The queue's Cron sweep (#670; `triggers.crons` in wrangler.jsonc, every 5 minutes). An Actions-only account has no
 * runner polling the claim route, which is where lapsed leases were swept until now, so the sweep runs them here too:
 * lapsed leases first (an Actions job is lost on its first lapse and its ephemeral identity revoked), then every
 * Actions job no run exchanged a token for within `ACTIONS_NO_SHOW_MINUTES` of its dispatch fails as `actions-no-show`,
 * and last the Actions jobs held back undispatched (#716: a role at `max_parallel`, a pause, the budget) are
 * dispatched once the exchange would admit them, so a freed slot is never left idle for want of a finish.
 */
export async function sweepQueue(env: ApiEnv, now: Date, logger: Logger, github: ApiGitHub): Promise<void> {
  const at = now.toISOString();
  const jobs = new JobsRepo(env.DB);
  const lapsed = await jobs.requeueLapsed(at);
  const teamState = new TeamStateRepo(env.DB);
  for (const lost of lapsed.lost) {
    await teamState.recordOutcome(lost.projectSlug, 'failed', at);
  }
  const noShows = await jobs.failActionsNoShows(at, ACTIONS_NO_SHOW_MINUTES, ACTIONS_NO_SHOW);
  const dispatched = await dispatchAdmittedActionsJobs(
    { env, github, logger, now: () => now },
    { projectSlug: null, limit: SWEEP_DISPATCH_MAX },
  );
  if (lapsed.requeued.length + lapsed.lost.length + noShows.length + dispatched > 0) {
    logger.info('queue swept', {
      requeued: lapsed.requeued.length,
      lost: lapsed.lost.length,
      noShows: noShows.length,
      dispatched,
    });
  }
}
