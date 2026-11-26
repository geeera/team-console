import { ACTIONS_WORKFLOW_FILE } from '@shared/contracts';
import { githubUnexpectedError, mapGitHubResponse } from './errors';
import { githubPath } from './github-path';
import type { RepoName } from './repo-name';
import { assertScopedKind, type ScopedInstallationToken } from './scoped-mint';
import {
  discardBody,
  githubRequest,
  readGitHubJson,
  type FetchLike,
  type GitHubTransportOptions,
} from './transport';

function workflowRunIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const id = (body as Record<string, unknown>)['workflow_run_id'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

/**
 * `POST /repos/{owner}/{repo}/actions/workflows/team-console-runner.yml/dispatches` (#670; architect note on #573):
 * starts the runner workflow on `ref` with the one input `job_id`, and asks GitHub for the run it created
 * (`return_run_details`, #723 item 2): the returned `workflow_run_id`, as a decimal string, is the only run the
 * exchange then takes the job for. `token` is an `actions-dispatch` scoped token, used for this call alone and never
 * logged. Anything but a 200 naming a run is thrown as a `GitHubError` carrying GitHub's status (403 for an
 * installation without `actions: write`, 404 without the workflow file); a 2xx without a run id is 502
 * `github-unexpected`, since a run the console cannot name would never be admitted.
 */
export async function dispatchRunnerWorkflow(
  fetcher: FetchLike,
  token: ScopedInstallationToken<'actions-dispatch'>,
  repo: RepoName,
  ref: string,
  jobId: string,
  options: GitHubTransportOptions & { readonly now?: number } = {},
): Promise<string> {
  assertScopedKind(token, 'actions-dispatch');
  const response = await githubRequest(
    fetcher,
    {
      method: 'POST',
      path: githubPath`/repos/${repo}/actions/workflows/${ACTIONS_WORKFLOW_FILE}/dispatches`,
      bearer: token.bearer(),
      body: { ref, inputs: { job_id: jobId }, return_run_details: true },
    },
    options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal },
  );
  if (!response.ok) {
    await discardBody(response);
    throw mapGitHubResponse(response, options.now ?? Date.now());
  }
  if (response.status === 204) {
    await discardBody(response);
    throw githubUnexpectedError('GitHub started the workflow without naming its run', response.status);
  }
  const runId = workflowRunIdOf(await readGitHubJson(response));
  if (runId === null) {
    throw githubUnexpectedError('GitHub named no workflow run for the dispatch', response.status);
  }
  return runId;
}
