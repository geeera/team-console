import { installationToken } from '../testing/github-kit';
import type { Logger } from '@worker/core';
import { dispatchRunnerWorkflow } from './actions-dispatch';
import { GitHubAppAuth } from './app-auth';
import { ScopedInstallationToken, type ScopedMintAudit } from './scoped-mint';
import { GitHubError } from './errors';
import { createMockGitHub, type MockGitHub } from './mock';
import { parseRepoName } from './repo-name';
import type { FetchLike } from './transport';

// #670: the Actions dispatch token and the `workflow_dispatch` call, against the mock GitHub app (which grants
// `actions: write` on geeera/team-console only, as an installation the owner granted it on would).

const TEAM_CONSOLE = { installation: 1001, id: 900001, repo: 'geeera/team-console' };
const PRIVATE_PRODUCT = { installation: 1001, id: 900002, repo: 'geeera/private-product' };
const noAudit: ScopedMintAudit = async () => undefined;

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

describe('the actions-dispatch scoped mint and dispatchRunnerWorkflow', () => {
  let mock: MockGitHub;
  let auth: GitHubAppAuth;
  let recordingFetch: FetchLike;
  const calls: { method: string; path: string; body: string | undefined }[] = [];

  beforeAll(async () => {
    mock = await createMockGitHub();
    recordingFetch = async (input, init) => {
      calls.push({
        method: init.method ?? 'GET',
        path: new URL(input).pathname,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      return mock.fetch(input, init);
    };
    auth = new GitHubAppAuth(mock.credentials, { fetch: recordingFetch });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('mints a token for one repository by id with actions: write only, and dispatches the runner workflow with it', async () => {
    const token = await auth.mintScoped('actions-dispatch', { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id }, noAudit);
    const mint = calls.find((call) => call.path.endsWith('/access_tokens'));
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({ repository_ids: [TEAM_CONSOLE.id], permissions: { actions: 'write' } });
    const runId = await dispatchRunnerWorkflow(
      recordingFetch,
      token,
      parseRepoName(TEAM_CONSOLE.repo),
      'dev',
      '01M7K0DGZ2FKYQNH7RVHYQN6BS',
    );
    // #723 item 2: GitHub is asked to name the run it starts, and that run id is what the dispatch answers.
    expect(runId).toMatch(/^[1-9][0-9]*$/);
    const dispatch = calls.find((call) => call.path.endsWith('/dispatches'));
    expect(JSON.parse(dispatch?.body ?? '{}')).toEqual({
      ref: 'dev',
      inputs: { job_id: '01M7K0DGZ2FKYQNH7RVHYQN6BS' },
      return_run_details: true,
    });
  });

  it.each([
    ['204 without run details', () => new Response(null, { status: 204 })],
    ['200 without a workflow_run_id', () => Response.json({ run_url: 'https://api.github.com/x' })],
    ['200 with a run id that is no positive integer', () => Response.json({ workflow_run_id: '12' })],
  ] as const)('refuses a dispatch answered %s with 502 github-unexpected', async (_label, answer) => {
    const error = await rejection(
      dispatchRunnerWorkflow(async () => answer(), new ScopedInstallationToken('actions-dispatch', 1, 1, installationToken('x')), parseRepoName(TEAM_CONSOLE.repo), 'dev', '01M7K0DGZ2FKYQNH7RVHYQN6BS'),
    );
    expect(error.problem.type).toBe('github-unexpected');
  });

  it('never caches the dispatch token: every call mints anew', async () => {
    const first = await auth.mintScoped('actions-dispatch', { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id }, noAudit);
    const second = await auth.mintScoped('actions-dispatch', { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id }, noAudit);
    expect(first.bearer()).not.toBe(second.bearer());
    expect(calls.filter((call) => call.path.endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('throws GitHub’s 422 when the installation lacks actions: write on the repository', async () => {
    const error = await rejection(auth.mintScoped('actions-dispatch', { installationId: PRIVATE_PRODUCT.installation, repositoryId: PRIVATE_PRODUCT.id }, noAudit));
    expect(error.githubStatus).toBe(422);
  });

  it('refuses the dispatch with a token of another repository (404), and with a read-only token (403)', async () => {
    const token = await auth.mintScoped('actions-dispatch', { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id }, noAudit);
    const other = await rejection(
      dispatchRunnerWorkflow(mock.fetch, token, parseRepoName(PRIVATE_PRODUCT.repo), 'main', '01M7K0DGZ2FKYQNH7RVHYQN6BS'),
    );
    expect(other.githubStatus).toBe(404);

    const read = await auth.tokenSourceFor(parseRepoName(TEAM_CONSOLE.repo)).getToken();
    const readOnly = await rejection(
      dispatchRunnerWorkflow(mock.fetch, new ScopedInstallationToken('actions-dispatch', TEAM_CONSOLE.installation, TEAM_CONSOLE.id, read), parseRepoName(TEAM_CONSOLE.repo), 'dev', '01M7K0DGZ2FKYQNH7RVHYQN6BS'),
    );
    expect(readOnly.githubStatus).toBe(403);
  });
});

describe('revokeScoped of a dispatch token (#723 item 1)', () => {
  interface LogEntry {
    readonly level: string;
    readonly message: string;
    readonly fields: unknown;
  }

  function recordingLogger(): Logger & { readonly entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const log =
      (level: string) =>
      (message: string, fields?: unknown): void => {
        entries.push({ level, message, fields });
      };
    return { entries, info: log('info'), warn: log('warn'), error: log('error') };
  }

  it('sends DELETE /installation/token with the token after its dispatch, so it no longer dispatches', async () => {
    const mock = await createMockGitHub();
    const calls: { method: string; path: string; authorization: string | null }[] = [];
    const fetch: FetchLike = async (input, init) => {
      calls.push({
        method: init.method ?? 'GET',
        path: new URL(input).pathname,
        authorization: new Headers(init.headers).get('authorization'),
      });
      return mock.fetch(input, init);
    };
    const logger = recordingLogger();
    const auth = new GitHubAppAuth(mock.credentials, { fetch, logger });
    const token = await auth.mintScoped('actions-dispatch', { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id }, noAudit);
    const repo = parseRepoName(TEAM_CONSOLE.repo);
    await dispatchRunnerWorkflow(fetch, token, repo, 'dev', '01M7K0DGZ2FKYQNH7RVHYQN6BS');
    await auth.revokeScoped(token);

    const [post, del] = calls.filter((call) => call.path.endsWith('/dispatches') || call.method === 'DELETE');
    expect(post?.method).toBe('POST');
    expect(del).toEqual({ method: 'DELETE', path: '/installation/token', authorization: `Bearer ${token.bearer()}` });
    expect(logger.entries).toEqual([]);
    const reused = await rejection(dispatchRunnerWorkflow(fetch, token, repo, 'dev', '01M7K0DGZ2FKYQNH7RVHYQN6BS'));
    expect(reused.githubStatus).toBe(401);
  });

  it.each([
    ['GitHub refuses it', async () => new Response(null, { status: 500 }), { githubStatus: 500 }],
    [
      'the request never reaches GitHub',
      async () => {
        throw new TypeError('network down');
      },
      { reason: 'github-unavailable' },
    ],
  ] as const)('only logs a failed revoke when %s, never the token, and never throws', async (_label, answer, logged) => {
    const mock = await createMockGitHub();
    const fetch: FetchLike = async (input, init) => (init.method === 'DELETE' ? answer() : mock.fetch(input, init));
    const logger = recordingLogger();
    const auth = new GitHubAppAuth(mock.credentials, { fetch, logger });
    const token = await auth.mintScoped('actions-dispatch', { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id }, noAudit);
    await expect(auth.revokeScoped(token)).resolves.toBeUndefined();
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'dispatch installation token not revoked',
        fields: { installationId: TEAM_CONSOLE.installation, ...logged },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(token.bearer());
  });
});
