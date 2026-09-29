import { problem, type WorkerContext } from '@worker/core';
import { ProjectsRepo, type ProjectRow } from '@worker/db';
import { InvalidRepoNameError, parseRepoName, type RepoName } from '@worker/github';
import type { ApiEnv } from '../env';

// Threat row 2 of #9: a slug with `/`, `..` or an encoded slash never reaches D1 or GitHub. Looser than the
// registry's slug rule on purpose: lookups only need to be safe, and a stricter rule lives on write.
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** The active project behind `:slug`; archived and unknown slugs are both `null` (404 `project-not-found`). */
export async function findProject(c: WorkerContext<ApiEnv>, slug: string): Promise<ProjectRow | null> {
  return SLUG_PATTERN.test(slug) ? new ProjectsRepo(c.env.DB).findActiveBySlug(slug) : null;
}

export function projectNotFound(c: WorkerContext<ApiEnv>): Response {
  return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
}

/** The row's repository as a validated name, or a 500 problem for a row that holds something else. */
export function repoOf(c: WorkerContext<ApiEnv>, project: ProjectRow): RepoName | Response {
  try {
    return parseRepoName(project.repo);
  } catch (error: unknown) {
    if (!(error instanceof InvalidRepoNameError)) {
      throw error;
    }
    // Registry rows are validated on write (#15); one that is not is our data, so it never reaches a URL.
    c.get('logger').error('registry row holds an invalid repository name', { slug: project.slug });
    return problem(c, {
      type: 'project-invalid',
      title: 'The project has an invalid repository name',
      status: 500,
    });
  }
}
