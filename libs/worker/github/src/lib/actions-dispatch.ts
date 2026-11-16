import { ACTIONS_WORKFLOW_FILE } from '@shared/contracts';
import { mapGitHubResponse } from './errors';
import { githubPath } from './github-path';
import type { RepoName } from './repo-name';
import { discardBody, githubRequest, type FetchLike, type GitHubTransportOptions } from './transport';

/**
 * `POST /repos/{owner}/{repo}/actions/workflows/team-console-runner.yml/dispatches` (#670; architect note on #573):
 * starts the runner workflow on `ref` with the one input `job_id`. `token` is a `mintForActionsDispatch` token, used
 * for this call alone and never logged. GitHub answers 204; anything else is thrown as the mapped `GitHubError`
 * carrying GitHub's status (403 for an installation without `actions: write`, 404 without the workflow file). Any 2xx
 * counts as accepted (204 today; 200 when GitHub returns run details).
 */
export async function dispatchRunnerWorkflow(
  fetcher: FetchLike,
  token: string,
  repo: RepoName,
  ref: string,
  jobId: string,
  options: GitHubTransportOptions & { readonly now?: number } = {},
): Promise<void> {
  const response = await githubRequest(
    fetcher,
    {
      method: 'POST',
      path: githubPath`/repos/${repo}/actions/workflows/${ACTIONS_WORKFLOW_FILE}/dispatches`,
      bearer: token,
      body: { ref, inputs: { job_id: jobId } },
    },
    options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal },
  );
  await discardBody(response);
  if (!response.ok) {
    throw mapGitHubResponse(response, options.now ?? Date.now());
  }
}
