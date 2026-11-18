import { runnerScopeCovers, type RunnerProjectScopeDto } from '@shared/contracts';

/**
 * The route-level reading of a runner's scope on a job (#775): the job is of the runner's account and the scope covers
 * its project — `all`, or the slug in `allowedProjects`. A pre-check for the 404/403 the routes answer; the binding
 * judgement is the SQL term (`runnerServesSql`, which also applies owner decision D3) inside the claim and every
 * job-token write, so a narrowing that commits in between still wins there.
 */
export function runnerServesJob(
  runner: RunnerProjectScopeDto & { readonly accountId: string },
  job: { readonly accountId: string; readonly projectSlug: string },
): boolean {
  return runner.accountId === job.accountId && runnerScopeCovers(runner, job.projectSlug);
}
