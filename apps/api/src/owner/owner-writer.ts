import type { Logger } from '@worker/core';
import { GitHubClient, GitHubError, assertRepoOwnedBy, type RepoName } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { readRepository, repositoryClient } from '../projects/repository-checks';

/**
 * The client of an owner write (ADR 0003 decision 2(b)): the repository must belong to the connected account (login
 * and pinned id), and writes go out on the owner's user token — the installation token only reads. Everything the
 * token needs (a refresh, the lease) happens here, before the caller sends anything.
 */
export async function ownerWriter(
  env: ApiEnv,
  logger: Logger,
  github: ApiGitHub,
  installation: GitHubConnection,
  target: { readonly repo: RepoName; readonly registered: string },
): Promise<GitHubClient> {
  const owner = await github.ownerConnection(env, logger);
  const account = await owner.account();
  const repository = await readRepository(repositoryClient(installation, target.repo), target.repo);
  assertRepoOwnedBy(account, repository.owner, target.registered);
  await owner.getToken();
  return new GitHubClient(github.ownerFetch(env), owner);
}

/**
 * GitHub certainly did not write: the owner token was refused (403 not-connected, only thrown before or instead of a
 * write) or GitHub answered 4xx. After a timeout, a 5xx or an unreadable 2xx it may have.
 */
export function isNotWritten(error: unknown): boolean {
  if (!(error instanceof GitHubError)) {
    return false;
  }
  if (error.problem.type === 'github-owner-not-connected') {
    return true;
  }
  return error.githubStatus !== null && error.githubStatus >= 400 && error.githubStatus < 500;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
