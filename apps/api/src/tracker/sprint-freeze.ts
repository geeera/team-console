import { DEFAULT_FREEZE_DAYS, MAX_FREEZE_DAYS, freezeOf, isInFreeze } from '@shared/contracts';
import { problem, type WorkerContext } from '@worker/core';
import { GitHubError } from '@worker/github';
import { sprintToday } from '@worker/read-models';
import { trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { repoOf } from '../projects/lookup';
import { ProjectReads, freezeDaysOfFile } from '../read-models/project-reads';

type Context = WorkerContext<ApiEnv>;

/**
 * project.yml's `sprint.freeze_days` through the shared cached read (ADR 0006 decision 9 keeps the file in the
 * repository). GitHub failing falls back to the plugin's default, logged: a move must not wait on GitHub.
 */
async function freezeDaysFor(c: Context, github: ApiGitHub): Promise<number> {
  const project = trackerProjectOfContext(c);
  const repo = repoOf(c, project);
  if (repo instanceof Response) {
    return DEFAULT_FREEZE_DAYS;
  }
  try {
    const reads = new ProjectReads(github, c.env, project, repo, github.now);
    return freezeDaysOfFile(await reads.projectYmlFile());
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    c.get('logger').warn('sprint freeze days unread, default used', {
      slug: project.slug,
      githubStatus: error.githubStatus,
    });
    return DEFAULT_FREEZE_DAYS;
  }
}

/**
 * #556: an item moved into a sprint during its freeze (the plugin takes no new work then, #409 §2.2) is a 409
 * `sprint-frozen`. Moving out of a frozen sprint is never judged. GitHub is read only when today is within the
 * longest possible freeze of the demo, so most moves cost no subrequest.
 */
export async function frozenSprintRefusal(
  c: Context,
  github: ApiGitHub,
  sprint: { readonly number: number; readonly dueOn: string | null },
): Promise<Response | null> {
  if (sprint.dueOn === null) {
    return null;
  }
  const today = sprintToday(github.now());
  if (!isInFreeze(today, freezeOf(sprint.dueOn, MAX_FREEZE_DAYS))) {
    return null;
  }
  const freeze = freezeOf(sprint.dueOn, await freezeDaysFor(c, github));
  if (!isInFreeze(today, freeze)) {
    return null;
  }
  return problem(c, {
    type: 'sprint-frozen',
    title: 'The sprint is in its freeze',
    status: 409,
    detail: `Sprint ${String(sprint.number)} takes no new items from ${freeze.from} to its demo; move it to a later sprint or the backlog`,
  });
}
