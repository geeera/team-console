import { Hono } from 'hono';
import { isRunnerVersionBelow, type RunnerSelfDto } from '@shared/contracts';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { RunnersRepo } from '@worker/db';
import type { ApiEnv } from '../env';
import { runnerReleaseOf } from './runner';
import { runnerOf } from './runner-jobs';
import { runnerPauseOf } from './runner-pause';

/**
 * `GET /api/v1/runner/self` (#775, architect note on #634 section 2; threat model R-SELF): what the runner needs to
 * hold itself to its scope without a restart and to compare its credential with each project's access source. The
 * exact key set of `RunnerSelfDto` and nothing else — no suspect mark, no country, no other runner, no policy, no
 * team config. `projects` is the claim's own answer (`runnerServesSql`, D3 applied) for the runner's account alone.
 * The runner JWT alone is the credential; a runner revoked since authentication answers as the door does.
 */
export function createRunnerSelfRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/self', async (c) => {
    const identity = runnerOf(c);
    const runners = new RunnersRepo(c.env.DB);
    const stored = await runners.findInAccount(identity.accountId, identity.runnerId);
    if (stored === null || stored.revokedAt !== null) {
      c.get('logger').warn('runner rejected', { reason: 'runner-revoked' });
      return problem(c, { type: 'runner-revoked', title: 'Unauthorized', status: 401 });
    }
    const now = new Date();
    const served = await runners.servedProjectsOf(stored.accountId, stored.id);
    const body: RunnerSelfDto = {
      runner: {
        id: stored.id,
        name: stored.name,
        accountId: stored.accountId,
        projectScope: stored.projectScope,
        allowedProjects: stored.allowedProjects,
        isolation: stored.isolation,
        version: stored.version,
        belowMinimum: isRunnerVersionBelow(stored.version, runnerReleaseOf(c.env).minimumVersion),
        pausedUntil: runnerPauseOf(stored, now)?.until ?? null,
        lastSeenAt: stored.lastSeenAt,
      },
      projects: served.map((project) => ({ slug: project.slug, accessSource: project.accessSource })),
    };
    return c.json(body);
  });
}
