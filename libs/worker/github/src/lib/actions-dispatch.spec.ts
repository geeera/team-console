import { dispatchRunnerWorkflow } from './actions-dispatch';
import { GitHubAppAuth } from './app-auth';
import { GitHubError } from './errors';
import { createMockGitHub, type MockGitHub } from './mock';
import { parseRepoName } from './repo-name';
import type { FetchLike } from './transport';

// #670: the Actions dispatch token and the `workflow_dispatch` call, against the mock GitHub app (which grants
// `actions: write` on geeera/team-console only, as an installation the owner granted it on would).

const TEAM_CONSOLE = { installation: 1001, id: 900001, repo: 'geeera/team-console' };
const PRIVATE_PRODUCT = { installation: 1001, id: 900002, repo: 'geeera/private-product' };

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubError');
}

describe('mintForActionsDispatch and dispatchRunnerWorkflow', () => {
  let mock: MockGitHub;
  let auth: GitHubAppAuth;
  const calls: { method: string; path: string; body: string | undefined }[] = [];

  beforeAll(async () => {
    mock = await createMockGitHub();
    const recording: FetchLike = async (input, init) => {
      calls.push({
        method: init.method ?? 'GET',
        path: new URL(input).pathname,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      return mock.fetch(input, init);
    };
    auth = new GitHubAppAuth(mock.credentials, { fetch: recording });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('mints a token for one repository by id with actions: write only, and dispatches the runner workflow with it', async () => {
    const token = await auth.mintForActionsDispatch(TEAM_CONSOLE.installation, TEAM_CONSOLE.id);
    const mint = calls.find((call) => call.path.endsWith('/access_tokens'));
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({ repository_ids: [TEAM_CONSOLE.id], permissions: { actions: 'write' } });
    await expect(
      dispatchRunnerWorkflow(mock.fetch, token, parseRepoName(TEAM_CONSOLE.repo), 'dev', '01M7K0DGZ2FKYQNH7RVHYQN6BS'),
    ).resolves.toBeUndefined();
  });

  it('never caches the dispatch token: every call mints anew', async () => {
    const first = await auth.mintForActionsDispatch(TEAM_CONSOLE.installation, TEAM_CONSOLE.id);
    const second = await auth.mintForActionsDispatch(TEAM_CONSOLE.installation, TEAM_CONSOLE.id);
    expect(first).not.toBe(second);
    expect(calls.filter((call) => call.path.endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('throws GitHub’s 422 when the installation lacks actions: write on the repository', async () => {
    const error = await rejection(auth.mintForActionsDispatch(PRIVATE_PRODUCT.installation, PRIVATE_PRODUCT.id));
    expect(error.githubStatus).toBe(422);
  });

  it('refuses the dispatch with a token of another repository (404), and with a read-only token (403)', async () => {
    const token = await auth.mintForActionsDispatch(TEAM_CONSOLE.installation, TEAM_CONSOLE.id);
    const other = await rejection(
      dispatchRunnerWorkflow(mock.fetch, token, parseRepoName(PRIVATE_PRODUCT.repo), 'main', '01M7K0DGZ2FKYQNH7RVHYQN6BS'),
    );
    expect(other.githubStatus).toBe(404);

    const read = await auth.tokenSourceFor(parseRepoName(TEAM_CONSOLE.repo)).getToken();
    const readOnly = await rejection(
      dispatchRunnerWorkflow(mock.fetch, read, parseRepoName(TEAM_CONSOLE.repo), 'dev', '01M7K0DGZ2FKYQNH7RVHYQN6BS'),
    );
    expect(readOnly.githubStatus).toBe(403);
  });
});
