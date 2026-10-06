import { GitHubAppAuth, INSTALLATION_PERMISSIONS } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { githubPath } from './github-path';
import fixtures from '../../fixtures/mock-github.json';
import { MOCK_OWNER_ACCOUNT, createMockGitHub, isGitHubMockEnabled, type MockGitHub } from './mock';
import { isRepoOwnedBy } from './owner-check';
import { parseRepoName } from './repo-name';

const noLastPage = (): boolean => false;
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
      client('geeera/team-console').getJson(githubPath`/repos/${repo}/issues/${21}`, isObject),
    ).resolves.toMatchObject({
      number: 21,
      state: 'open',
      labels: [{ name: 'status:blocked' }, { name: 'kind:chore' }, { name: 'needs:owner' }],
      html_url: 'https://github.com/geeera/team-console/issues/21',
    });
    const missing = await rejection(
      client('geeera/team-console').getJson(githubPath`/repos/${repo}/issues/${999}`, isObject),
    );
    expect(missing.problem.type).toBe('github-not-found');
  });

  it.each([72, 90001, 90002])(
    "serves the owner's own labeled e2e:fixture event for fixture issue #%i (#193)",
    async (number) => {
      const repo = parseRepoName('geeera/team-console');
      const tail = await client('geeera/team-console').lastPage(
        githubPath`/repos/${repo}/issues/${number}/events?per_page=${100}`,
        isObject,
        noLastPage,
      );
      expect(tail.isWholeList).toBe(true);
      expect(tail.items.at(-1)).toMatchObject({
        event: 'labeled',
        actor: { login: MOCK_OWNER_ACCOUNT.login, type: 'User' },
        label: { name: 'e2e:fixture' },
        performed_via_github_app: null,
      });
    },
  );

  it('serves no events for an issue without any, and 404 for an unknown issue', async () => {
    const repo = parseRepoName('geeera/team-console');
    await expect(
      client('geeera/team-console').lastPage(
        githubPath`/repos/${repo}/issues/${21}/events`,
        isObject,
        noLastPage,
      ),
    ).resolves.toEqual({ items: [], isWholeList: true });
    const missing = await rejection(
      client('geeera/team-console').lastPage(
        githubPath`/repos/${repo}/issues/${999}/events`,
        isObject,
        noLastPage,
      ),
    );
    expect(missing.problem.type).toBe('github-not-found');
  });

  it('labels exactly the issues that have a fixture event, and only those, with e2e:fixture', () => {
    const repo = fixtures.repositories['geeera/team-console'];
    const labelled = repo.issues
      .filter((issue) => issue.labels.some((label) => label.name === 'e2e:fixture'))
      .map((issue) => String(issue.number))
      .sort();
    expect(Object.keys(repo.issueEvents).sort()).toEqual(labelled);
  });

  it('lists issues by state and milestone, open milestones and open pull requests from the same fixture', async () => {
    const repo = parseRepoName('geeera/team-console');
    const isList = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value);
    const github = client('geeera/team-console');
    const open = await github.getJson(githubPath`/repos/${repo}/issues?state=open&per_page=${100}`, isList);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((item) => item['state'] === 'open')).toBe(true);
    const sprint = await github.getJson(
      githubPath`/repos/${repo}/issues?state=all&milestone=${1}&per_page=${100}`,
      isList,
    );
    expect(sprint.some((item) => item['state'] === 'closed')).toBe(true);
    expect(sprint.every((item) => (item['milestone'] as { number?: number } | null)?.number === 1)).toBe(
      true,
    );
    const milestones = await github.getJson(githubPath`/repos/${repo}/milestones?state=open`, isList);
    expect(milestones.map((m) => m['title'])).toEqual(['Sprint 01', 'Sprint 02']);
    const pulls = await github.getJson(githubPath`/repos/${repo}/pulls?state=open`, isList);
    expect(pulls.map((p) => p['number'])).toEqual([92, 91, 45, 40]);
  });

  it('serves check runs per head sha (#131), and none for a sha it does not know', async () => {
    const repo = parseRepoName('geeera/team-console');
    const isPage = (value: unknown): value is { total_count: number; check_runs: unknown[] } =>
      typeof value === 'object' && value !== null && 'check_runs' in value;
    const github = client('geeera/team-console');
    const failing = await github.getJson(
      githubPath`/repos/${repo}/commits/${'40fa11ed'.repeat(5)}/check-runs?filter=latest`,
      isPage,
    );
    expect(failing.total_count).toBe(2);
    expect(failing.check_runs).toContainEqual(expect.objectContaining({ conclusion: 'failure' }));
    const none = await github.getJson(
      githubPath`/repos/${repo}/commits/${'91deadbe'.repeat(5)}/check-runs?filter=latest`,
      isPage,
    );
    expect(none).toEqual({ total_count: 0, check_runs: [] });
  });

  it("serves the run log's thread (#132), and an empty one for an issue without fixture comments", async () => {
    const repo = parseRepoName('geeera/team-console');
    const isList = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value);
    const github = client('geeera/team-console');
    const log = await github.getJson(
      githubPath`/repos/${repo}/issues/${22}/comments?per_page=${100}`,
      isList,
    );
    expect(log.length).toBeGreaterThan(5);
    // One edited team entry and one outsider entry, for the board's provenance rule.
    expect(log.some((comment) => comment['updated_at'] !== comment['created_at'])).toBe(true);
    expect(log.some((comment) => (comment['user'] as { login?: string }).login === 'outsider')).toBe(true);
    const issue = await github.getJson(githubPath`/repos/${repo}/issues/${22}`, isObject);
    expect(issue['comments']).toBe(log.length);
    const other = await github.getJson(githubPath`/repos/${repo}/issues/${31}/comments`, isList);
    expect(other).toEqual([]);
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

  describe('the installation list (#194)', () => {
    it('finds the owner account installation by id and lists its repositories with the list token', async () => {
      const installationId = await auth.installationIdForAccount(MOCK_OWNER_ACCOUNT.userId);
      expect(installationId).toBe(1001);
      const list = await GitHubClient.listInstallationRepositories(
        mock.fetch,
        auth.listTokenSourceFor(installationId),
        { maxPages: 10 },
      );
      expect(list.complete).toBe(true);
      expect(list.items).toEqual(
        expect.arrayContaining([
          { fullName: 'geeera/team-console', private: false },
          { fullName: 'geeera/private-product', private: true },
          { fullName: 'geeera/no-yml', private: true },
        ]),
      );
      expect(list.items.map((repo) => repo.fullName)).not.toContain('acme/site');
    });

    it('answers 409 for an account without an installation', async () => {
      expect((await rejection(auth.installationIdForAccount(7))).problem.type).toBe(
        'github-app-not-installed',
      );
    });

    it('pages with per_page and a Link header', async () => {
      const source = auth.listTokenSourceFor(1001);
      const token = await source.getToken();
      const first = await mock.fetch('https://api.github.com/installation/repositories?per_page=2', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await first.json()) as { repositories: unknown[] };
      expect(body.repositories).toHaveLength(2);
      expect(first.headers.get('link')).toBe(
        '<https://api.github.com/installation/repositories?per_page=2&page=2>; rel="next"',
      );
    });

    it('tripwires: the list token cannot read a repository, a per-repository token cannot list', async () => {
      const listToken = await auth.listTokenSourceFor(1001).getToken();
      const read = await mock.fetch('https://api.github.com/repos/geeera/team-console', {
        headers: { Authorization: `Bearer ${listToken}` },
      });
      expect(read.status).toBe(403);

      const repoToken = await auth.tokenSourceFor(parseRepoName('geeera/team-console')).getToken();
      const list = await mock.fetch('https://api.github.com/installation/repositories?per_page=100', {
        headers: { Authorization: `Bearer ${repoToken}` },
      });
      expect(list.status).toBe(403);
    });

    it('mints the list token only for exactly metadata: read without repositories', async () => {
      let jwt = '';
      const spyAuth = new GitHubAppAuth(mock.credentials, {
        fetch: async (input, init) => {
          jwt = new Headers(init.headers).get('authorization') ?? '';
          return mock.fetch(input, init);
        },
      });
      await spyAuth.installationIdForAccount(MOCK_OWNER_ACCOUNT.userId);
      const wider = await mock.fetch('https://api.github.com/app/installations/1001/access_tokens', {
        method: 'POST',
        headers: { Authorization: jwt },
        body: JSON.stringify({ permissions: { metadata: 'read', contents: 'read' } }),
      });
      expect(wider.status).toBe(422);
    });
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
