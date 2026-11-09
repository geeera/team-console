import { PullRequestsRepo, type ProjectRow } from '@worker/db';
import { readCacheKey, type RepoName } from '@worker/github';
import { VcsError, type CiState, type PullRequest, type RepoRef, type VcsAdapter } from '@worker/vcs';
import { GitHubVcsAdapter } from '@worker/vcs-github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
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
/** `GET …/prs/:number?fresh=1`: token 2 + the pull request 1 + its CI 1. */
export const PULL_REQUEST_READ_BUDGET = 6;

export interface SyncOutcome {
  readonly complete: boolean;
}

function refOf(repo: RepoName): RepoRef {
  // T-2 records `projects.repo_id`; until then the registered name is the reference, as in every other read.
  return { provider: 'github', owner: repo.owner, name: repo.name, externalId: null };
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
 * they were and make the outcome incomplete. Shared per isolate for `SYNC_TTL_SECONDS` through the read cache.
 */
export function syncPullRequests(
  github: ApiGitHub,
  env: ApiEnv,
  project: ProjectRow,
  repo: RepoName,
  now: () => number,
): Promise<SyncOutcome> {
  const key = readCacheKey({
    environment: env.ENVIRONMENT,
    slug: project.slug,
    epoch: project.cache_epoch,
    type: 'pull-requests-sync',
  });
  return github.readCache.getOrFill(key, SYNC_TTL_SECONDS, async () => {
    const adapter = await adapterFor(github, env, repo, PULL_REQUEST_SYNC_BUDGET);
    const rows = new PullRequestsRepo(env.DB);
    const ref = refOf(repo);
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
      await rows.upsert(project.slug, pull, { repositoryId: null, syncedAt: syncedAt() });
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
            await rows.upsert(project.slug, pull, { repositoryId: null, syncedAt: syncedAt() });
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
 * first read of a number D1 does not hold). `null` when the provider has no such pull request.
 */
export async function syncPullRequest(
  github: ApiGitHub,
  env: ApiEnv,
  project: ProjectRow,
  repo: RepoName,
  number: number,
  now: () => number,
): Promise<boolean> {
  const adapter = await adapterFor(github, env, repo, PULL_REQUEST_READ_BUDGET);
  const ref = refOf(repo);
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
    repositoryId: null,
    syncedAt: new Date(now()).toISOString(),
    ...(ci === undefined ? {} : { ci }),
  });
  return true;
}
