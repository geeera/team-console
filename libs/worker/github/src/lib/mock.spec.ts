import { GitHubAppAuth, INSTALLATION_PERMISSIONS } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { githubPath } from './github-path';
import fixtures from '../../fixtures/mock-github.json';
import { MOCK_OWNER_ACCOUNT, createMockGitHub, isGitHubMockEnabled, type MockGitHub } from './mock';
import { isRepoOwnedBy } from './owner-check';
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

  it('serves a fixture file through the contents API as base64, and 404 for a missing one', async () => {
    const repo = parseRepoName('geeera/team-console');
    const file = await client('geeera/team-console').getJson(
      githubPath`/repos/${repo}/contents/.product-team/project.yml`,
      isObject,
    );
    expect(file).toMatchObject({ type: 'file', encoding: 'base64', path: '.product-team/project.yml' });
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(String(file['content'])), (char) => char.charCodeAt(0)),
    );
    expect(text).toContain('language: ru');

    const noYml = parseRepoName('geeera/no-yml');
    const error = await rejection(
      client('geeera/no-yml').getJson(
        githubPath`/repos/${noYml}/contents/.product-team/project.yml`,
        isObject,
      ),
    );
    expect(error.problem.type).toBe('github-not-found');
  });

  it('serves a fixture issue with its labels as GitHub sends them, and 404 for an unknown one', async () => {
    const repo = parseRepoName('geeera/team-console');
    await expect(
      client('geeera/team-console').getJson(githubPath`/repos/${repo}/issues/${8}`, isObject),
    ).resolves.toMatchObject({
      number: 8,
      state: 'open',
      labels: [{ name: 'team:demo' }, { name: 'kind:chore' }],
    });
    const missing = await rejection(
      client('geeera/team-console').getJson(githubPath`/repos/${repo}/issues/${999}`, isObject),
    );
    expect(missing.problem.type).toBe('github-not-found');
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

describe('MOCK_OWNER_ACCOUNT', () => {
  it('owns the fixtures under its login, with the same id (so local registry runs pass the owner check)', () => {
    const owners = Object.entries(fixtures.repositories)
      .filter(([name]) => name.startsWith(`${MOCK_OWNER_ACCOUNT.login}/`))
      .map(
        ([, fixture]) =>
          (fixture as { repository?: { owner?: { login: string; id: number } } }).repository?.owner,
      )
      .filter((owner): owner is { login: string; id: number } => owner !== undefined);
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) {
      expect(isRepoOwnedBy(MOCK_OWNER_ACCOUNT, owner)).toBe(true);
    }
  });
});
