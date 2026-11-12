import { problem, type WorkerContext } from '@worker/core';
import type { ProjectRow } from '@worker/db';
import type { RepoName } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { ensureRepoId } from './pull-request-sync';

/**
 * The registered repository id, backfilled on first use; 409 `repo-id-unknown` when it cannot be recorded. Every
 * provider read by id goes through it: the pull request routes (#463) and the pr-link check (#529).
 */
export async function repoIdOf(
  c: WorkerContext<ApiEnv>,
  github: ApiGitHub,
  owners: OwnerConnectionSource,
  project: ProjectRow,
  repo: RepoName,
): Promise<number | Response> {
  const repoId = await ensureRepoId(github, c.env, project, repo, owners, c.get('logger'));
  if (repoId !== null) {
    return repoId;
  }
  c.get('logger').warn('provider read refused', { reason: 'repo-id-unknown', slug: project.slug });
  return problem(c, {
    type: 'repo-id-unknown',
    title: 'The repository id is not recorded',
    status: 409,
    detail: 'The provider’s id of this repository could not be recorded for the project',
  });
}
