import { GitHubAppAuth, INSTALLATION_PERMISSIONS } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { githubPath } from './github-path';
import { createMockGitHub, isGitHubMockEnabled, type MockGitHub } from './mock';
import { parseRepoName } from './repo-name';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

describe('isGitHubMockEnabled (row 7)', () => {
  it.each([
    ['local', 'true', true],
    ['local', 'false', false],
    ['local', undefined, false],
    ['dev', 'true', false],
    ['stage', 'true', false],
    ['production', 'true', false],
    ['LOCAL', 'true', false],
  ] as const)('ENVIRONMENT=%s GITHUB_MOCK=%s → %s', (environment, mock, expected) => {
    expect(
      isGitHubMockEnabled({ ENVIRONMENT: environment, ...(mock === undefined ? {} : { GITHUB_MOCK: mock }) }),
    ).toBe(expected);
  });
});

describe('createMockGitHub', () => {
  let mock: MockGitHub;
  let auth: GitHubAppAuth;

  beforeAll(async () => {
    mock = await createMockGitHub();
    auth = new GitHubAppAuth(mock.credentials, { fetch: mock.fetch });
  });

  function client(repo: string): GitHubClient {
    return new GitHubClient(mock.fetch, auth.tokenSourceFor(parseRepoName(repo)));
  }

  it('runs the real flow: JWT, installation, downscoped mint, read', async () => {
    const repo = parseRepoName('geeera/team-console');
    await expect(auth.installationIdFor(repo)).resolves.toBe(1001);
    await expect(
      client('geeera/team-console').getJson(githubPath`/repos/${repo}`, isObject),
    ).resolves.toMatchObject({
      full_name: 'geeera/team-console',
      default_branch: 'dev',
    });
  });

  it('answers 409 github-app-not-installed for a repository without the app', async () => {
    const error = await rejection(auth.installationIdFor(parseRepoName('someone/else')));
    expect(error.problem.type).toBe('github-app-not-installed');
  });

  it('scopes a token to its repository, as a downscoped GitHub token is', async () => {
    const other = parseRepoName('geeera/private-product');
    const error = await rejection(
      client('geeera/team-console').getJson(githubPath`/repos/${other}`, isObject),
    );
    expect(error.problem.type).toBe('github-not-found');
  });

  it('refuses a JWT it did not sign and a mint that is not downscoped', async () => {
    const lookup = await mock.fetch('https://api.github.com/repos/geeera/team-console/installation', {
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2ln' },
    });
    expect(lookup.status).toBe(401);

    const jwt = await (async () => {
      let seen = '';
      const spyAuth = new GitHubAppAuth(mock.credentials, {
        fetch: async (input, init) => {
          seen = new Headers(init.headers).get('authorization') ?? '';
          return mock.fetch(input, init);
        },
      });
      await spyAuth.installationIdFor(parseRepoName('geeera/team-console'));
      return seen;
    })();
    const everything = await mock.fetch('https://api.github.com/app/installations/1001/access_tokens', {
      method: 'POST',
      headers: { Authorization: jwt },
      body: JSON.stringify({
        repositories: ['team-console'],
        permissions: { ...INSTALLATION_PERMISSIONS, issues: 'write' },
      }),
    });
    expect(everything.status).toBe(422);
  });

  it.each([
    ['geeera/mock-rate-limited', 'github-rate-limit'],
    ['geeera/mock-unavailable', 'github-unavailable'],
    ['geeera/mock-redirect-off-host', 'github-unexpected'],
    ['geeera/mock-token-rejected', 'github-auth'],
  ])('serves %s as the %s row', async (name, type) => {
    const repo = parseRepoName(name);
    const error = await rejection(client(name).getJson(githubPath`/repos/${repo}`, isObject));
    expect(error.problem.type).toBe(type);
  });
});
