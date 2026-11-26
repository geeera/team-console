import { installationToken } from '../testing/github-kit';
import { GitHubAppAuth } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { createMockGitHub, type MockGitHub } from './mock';
import { readRegisteredRepository } from './registered-repository';
import { InvalidRepoNameError, parseRepoName } from './repo-name';
import type { InstallationTokenSource } from './token-source';
import type { FetchLike } from './transport';

// #724: the one read-and-verify of a registered repository the Actions dispatch and the switch to it share.

const TEAM_CONSOLE = parseRepoName('geeera/team-console');
const TEAM_CONSOLE_ID = 900001;

function fixedTokens(): InstallationTokenSource {
  return {
    kind: 'installation',
    repo: TEAM_CONSOLE,
    getToken: async () => installationToken('fixed'),
    invalidate: () => undefined,
  };
}

function answering(body: unknown): GitHubClient {
  const fetch: FetchLike = async () => Response.json(body);
  return new GitHubClient(fetch, fixedTokens());
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('readRegisteredRepository', () => {
  let mock: MockGitHub;
  let client: GitHubClient;

  beforeAll(async () => {
    mock = await createMockGitHub();
    const auth = new GitHubAppAuth(mock.credentials, { fetch: mock.fetch });
    client = new GitHubClient(mock.fetch, auth.tokenSourceFor(TEAM_CONSOLE));
  });

  it("answers GitHub's current name and default branch when GitHub's id is the recorded one", async () => {
    const repository = await readRegisteredRepository(client, TEAM_CONSOLE, TEAM_CONSOLE_ID);
    expect(repository?.current.fullName).toBe('geeera/team-console');
    expect(repository?.defaultBranch).toBe('dev');
  });

  it('answers null when GitHub names another repository under the registered name', async () => {
    await expect(readRegisteredRepository(client, TEAM_CONSOLE, TEAM_CONSOLE_ID + 1)).resolves.toBeNull();
  });

  it('takes the name GitHub answers with, so a renamed repository is dispatched under its new name', async () => {
    const repository = await readRegisteredRepository(
      answering({ id: TEAM_CONSOLE_ID, full_name: 'geeera/renamed', default_branch: 'main' }),
      TEAM_CONSOLE,
      TEAM_CONSOLE_ID,
    );
    expect(repository?.current.fullName).toBe('geeera/renamed');
    expect(repository?.defaultBranch).toBe('main');
  });

  it.each([
    ['no id', { full_name: 'geeera/team-console', default_branch: 'dev' }],
    ['no full_name', { id: TEAM_CONSOLE_ID, default_branch: 'dev' }],
    [
      'an empty default branch',
      { id: TEAM_CONSOLE_ID, full_name: 'geeera/team-console', default_branch: '' },
    ],
    ['no object at all', ['geeera/team-console']],
  ])('refuses an answer with %s as 502 github-unexpected', async (_label, body) => {
    const error = await rejection(readRegisteredRepository(answering(body), TEAM_CONSOLE, TEAM_CONSOLE_ID));
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).problem.type).toBe('github-unexpected');
  });

  it('throws InvalidRepoNameError for a full_name that is no repository name', async () => {
    const error = await rejection(
      readRegisteredRepository(
        answering({ id: TEAM_CONSOLE_ID, full_name: '../etc', default_branch: 'dev' }),
        TEAM_CONSOLE,
        TEAM_CONSOLE_ID,
      ),
    );
    expect(error).toBeInstanceOf(InvalidRepoNameError);
  });

  it("throws GitHub's 404 for a repository GitHub does not know", async () => {
    const fetch: FetchLike = async () => Response.json({ message: 'Not Found' }, { status: 404 });
    const error = await rejection(
      readRegisteredRepository(new GitHubClient(fetch, fixedTokens()), TEAM_CONSOLE, TEAM_CONSOLE_ID),
    );
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).githubStatus).toBe(404);
  });
});
