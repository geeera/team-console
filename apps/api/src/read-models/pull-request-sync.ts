import type { Logger } from '@worker/core';
import { ProjectsRepo, PullRequestsRepo, type ProjectRow } from '@worker/db';
import { GitHubError, readCacheKey, type ReadCacheKey, type RepoName } from '@worker/github';
import { VcsError, type CiState, type PullRequest, type RepoRef, type VcsAdapter } from '@worker/vcs';
import { GitHubVcsAdapter, vcsErrorOf } from '@worker/vcs-github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { isBackfillAllowed } from '../projects/repo-id-backfill';
import { readRepository, repositoryClient, type RepositoryRead } from '../projects/repository-checks';
import { SubrequestBudget } from './subrequest-budget';

/**
 * Subrequests of one on-demand sync (#463), cold isolate: token 2 + open pull requests ≤ OPEN_PAGES + rows the list no
 * longer shows ≤ RECHECK_MAX + one CI read per open head that needs it; whatever the budget leaves unread stays stale
 * and `complete: false` says so. Within the Worker's 50 with room for the request's own reads.
 */
export const PULL_REQUEST_SYNC_BUDGET = 40;
const OPEN_PAGES = 3;
const RECHECK_MAX = 10;
/** One sync per project and epoch per isolate at most this often; a webhook bump starts a new key. */
const SYNC_TTL_SECONDS = 30;
/** `GET …/prs/:number?fresh=1`: token 2 + the repository (its id checked) 1 + the pull request 1 + its CI 1. */
export const PULL_REQUEST_READ_BUDGET = 7;
/** One provider read of a number per project and epoch per isolate at most this often, a missing number included. */
const READ_TTL_SECONDS = 30;

export interface SyncOutcome {
  readonly complete: boolean;
}

/** The registered repository **by id** (ADR 0008 decision 2): the adapter refuses a name that now points elsewhere. */
function refOf(repo: RepoName, repoId: number): RepoRef {
  return { provider: 'github', owner: repo.owner, name: repo.name, externalId: String(repoId) };
}

/**
 * The project's repository id, recorded once from the provider when a row registered before 0018 has none (the T-2
 * backfill); `null` when the provider's id could not be recorded (another project holds it, or the repository the
 * name answers is not the connected owner's under that name, #509), in which case nothing is synced — fail closed.
 * Costs one read only on the backfill. The read is GitHub's own, not the adapter's: the owner check needs the
 * repository's owner, which the provider-neutral `Repository` does not carry.
 */
export async function ensureRepoId(
  github: ApiGitHub,
  env: ApiEnv,
  project: ProjectRow,
  repo: RepoName,
  owners: OwnerConnectionSource,
  logger: Logger,
): Promise<number | null> {
  if (project.repo_id !== null) {
    return project.repo_id;
  }
  const budget = new SubrequestBudget(PULL_REQUEST_READ_BUDGET);
  const client = repositoryClient(await budget.connectionFor(await github.connect(env), repo), repo);
  let read: RepositoryRead;
  try {
    read = await readRepository(client, repo);
  } catch (error: unknown) {
    // The same VcsError the adapter's read raised before #509, so the route's answers do not change.
    throw error instanceof GitHubError ? vcsErrorOf(error) : error;
  }
  if (read.id === null) {
    return null;
  }
  if (!isBackfillAllowed(read, await owners.current(env, logger), project.repo)) {
    // No slug: the refusal stays fail-closed and names no row (#504, #509).
    logger.warn('repo id backfill refused');
    return null;
  }
  return (await new ProjectsRepo(env.DB).setRepoId(project.slug, read.id)) ? read.id : null;
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: VcsError };

/**
 * `fill` through the read cache with its provider failure cached too (#481): a number GitHub does not have (`false`)
 * and a first list page that failed answer from the cache until the TTL ends, so a loop on either spends one read per
 * TTL instead of one per request of the installation's shared hourly quota. A failure that is not the provider's (a
 * bug, D1) is never cached.
 */
async function cachedRead<T>(
  github: ApiGitHub,
  key: ReadCacheKey,
  ttlSeconds: number,
  fill: () => Promise<T>,
): Promise<T> {
  const outcome = await github.readCache.getOrFill<Outcome<T>>(key, ttlSeconds, async () => {
    try {
      return { ok: true, value: await fill() };
    } catch (error: unknown) {
      if (error instanceof VcsError) {
        return { ok: false, error };
      }
      throw error;
    }
  });
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Errors the sync absorbs (the rest of the rows still answer); anything else is a bug and propagates. */
function isAbsorbed(error: unknown): boolean {
  return error instanceof VcsError && error.kind !== 'forbidden';
}

async function adapterFor(
  github: ApiGitHub,
  env: ApiEnv,
  repo: RepoName,
  limit: number,
): Promise<VcsAdapter> {
  const budget = new SubrequestBudget(limit);
  return new GitHubVcsAdapter(await budget.connectionFor(await github.connect(env), repo));
}

/**
 * Reads the project's pull requests from the provider into `pull_requests`: every open one, the rows D1 still has as
 * open that the list no longer shows (closed or merged since), then the CI of each open head whose state is stale.
 * The first list page must succeed (its failure is the request's problem); later reads that fail leave their rows as
 * they were and make the outcome incomplete. Shared per isolate for `SYNC_TTL_SECONDS` through the read cache, a
 * provider failure of the first page included.
 */
export function syncPullRequests(
  github: ApiGitHub,
  env: ApiEnv,
  project: ProjectRow,
  repo: RepoName,
  repoId: number,
  now: () => number,
): Promise<SyncOutcome> {
  const key = readCacheKey({
    environment: env.ENVIRONMENT,
    slug: project.slug,
    epoch: project.cache_epoch,
    type: 'pull-requests-sync',
  });
  return cachedRead(github, key, SYNC_TTL_SECONDS, async () => {
    const adapter = await adapterFor(github, env, repo, PULL_REQUEST_SYNC_BUDGET);
    const rows = new PullRequestsRepo(env.DB);
    const ref = refOf(repo, repoId);
    // The lists and reads below go by name; one repository read per sync proves the name still carries the
    // registered id (`vcs-repository-changed` otherwise), so a repository recreated under the name writes nothing.
    await adapter.repository(ref);
    const syncedAt = (): string => new Date(now()).toISOString();
    let complete = true;

    const open: PullRequest[] = [];
    let page: number | null = 1;
    while (page !== null && page <= OPEN_PAGES) {
      try {
        const read = await adapter.pullRequests.list(ref, { state: 'open' }, { page, perPage: 100 });
        open.push(...read.items);
        page = read.nextPage;
      } catch (error: unknown) {
        if (page === 1 || !isAbsorbed(error)) {
          throw error;
        }
        complete = false;
        break;
      }
    }
    if (page !== null) {
      complete = false;
    }
    for (const pull of open) {
      await rows.upsert(project.slug, pull, { repositoryId: repoId, syncedAt: syncedAt() });
    }

    // Only when the open list is whole can "not listed" mean "no longer open".
    if (complete) {
      const listed = new Set(open.map((pull) => pull.number));
      const vanished = (await rows.openNumbers(project.slug)).filter((number) => !listed.has(number));
      for (const [index, number] of vanished.entries()) {
        if (index >= RECHECK_MAX) {
          complete = false;
          break;
        }
        try {
          const pull = await adapter.pullRequests.get(ref, number);
          if (pull !== null) {
            await rows.upsert(project.slug, pull, { repositoryId: repoId, syncedAt: syncedAt() });
          }
        } catch (error: unknown) {
          if (!isAbsorbed(error)) {
            throw error;
          }
          complete = false;
        }
      }
    }

    for (const pull of open) {
      const row = await rows.find(project.slug, pull.number);
      if (row === null || !row.ciStale || row.headSha !== pull.headSha) {
        continue;
      }
      try {
        const ci = await adapter.ci.status(ref, pull.headSha);
        await rows.setCi(project.slug, pull.number, pull.headSha, ci, syncedAt());
      } catch (error: unknown) {
        // A head without the Checks permission or past the budget stays stale; the next sync goes on from there.
        if (!(error instanceof VcsError)) {
          throw error;
        }
        complete = false;
      }
    }
    return { complete };
  });
}

/**
 * One pull request read from the provider into its row, with its head's CI (`GET …/prs/:number?fresh=1`, and the
 * first read of a number D1 does not hold). `false` when the provider has no such pull request. Shared per isolate,
 * project, epoch and number for `READ_TTL_SECONDS` through the read cache — a missing number and a failed read too,
 * so an owner or a member looping on a number spends one read per TTL (#481); a delivery that writes the row bumps
 * the epoch, so a pull request opened since is not hidden behind a cached `false`.
 */
export function syncPullRequest(
  github: ApiGitHub,
  env: ApiEnv,
  project: ProjectRow,
  repo: RepoName,
  repoId: number,
  number: number,
  now: () => number,
): Promise<boolean> {
  const key = readCacheKey({
    environment: env.ENVIRONMENT,
    slug: project.slug,
    epoch: project.cache_epoch,
    type: `pull-request-${String(number)}`,
  });
  return cachedRead(github, key, READ_TTL_SECONDS, () =>
    readPullRequest(github, env, project, repo, repoId, number, now),
  );
}

async function readPullRequest(
  github: ApiGitHub,
  env: ApiEnv,
  project: ProjectRow,
  repo: RepoName,
  repoId: number,
  number: number,
  now: () => number,
): Promise<boolean> {
  const adapter = await adapterFor(github, env, repo, PULL_REQUEST_READ_BUDGET);
  const ref = refOf(repo, repoId);
  await adapter.repository(ref);
  const pull = await adapter.pullRequests.get(ref, number);
  if (pull === null) {
    return false;
  }
  let ci: CiState | undefined;
  try {
    ci = await adapter.ci.status(ref, pull.headSha);
  } catch (error: unknown) {
    if (!(error instanceof VcsError)) {
      throw error;
    }
    ci = undefined;
  }
  await new PullRequestsRepo(env.DB).upsert(project.slug, pull, {
    repositoryId: repoId,
    syncedAt: new Date(now()).toISOString(),
    ...(ci === undefined ? {} : { ci }),
  });
  return true;
}
