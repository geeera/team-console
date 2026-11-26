import {
  RUNNER_WORKFLOW_PATH,
  SETUP_BRANCHES_MAX,
  judgePullProvenance,
  readActionsSetupPull,
  readSetupBranches,
  sameWorkflowBytes,
  type ActionsSetupPull,
} from './actions-setup-pull';
import { GitHubAppAuth } from './app-auth';
import { GitHubClient } from './client';
import { MOCK_FIXTURES, createMockGitHub, type MockFixtures } from './mock';
import { parseRepoName } from './repo-name';
import type { FetchLike } from './transport';

// #759 PR 3: the console's setup PR, found by its head branch, and the provenance judgement behind `pr: foreign` and
// `pr: changed` (security note row "A PR that is not the console's is shown as the console's").

const REPO = 'acme/setup';
const REPO_ID = 920001;
const BRANCH = 'team-console/runner-0123456789ab';
const BOT = 'team-console-local[bot]';
const TEXT = 'name: team-console-runner\non:\n  workflow_dispatch:\n';
const HEAD_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);

const repository = (id: number, owner: string) => ({ id, owner: { login: owner } });

const pull = (number: number, overrides: Record<string, unknown>): Record<string, unknown> => ({
  number,
  state: 'open',
  html_url: `https://github.com/${REPO}/pull/${String(number)}`,
  user: { login: BOT, type: 'Bot' },
  head: { ref: BRANCH, sha: HEAD_SHA, repo: repository(REPO_ID, 'acme') },
  base: { ref: 'main', repo: repository(REPO_ID, 'acme') },
  commits: 1,
  changed_files: 1,
  ...overrides,
});

const FIXTURES: MockFixtures = {
  repositories: {
    ...MOCK_FIXTURES.repositories,
    [REPO]: {
      installationId: 2101,
      repository: {
        id: REPO_ID,
        full_name: REPO,
        private: true,
        default_branch: 'main',
        owner: { login: 'acme', id: 300101 },
      },
      pulls: [
        // A fork's PR from a branch of the same name: the `<owner>:<branch>` head filter never matches it.
        pull(6, {
          head: { ref: BRANCH, sha: OTHER_SHA, repo: repository(1, 'forker') },
          user: { login: 'forker', type: 'User' },
        }),
        pull(5, {}),
      ],
      pullFiles: { '5': [{ filename: RUNNER_WORKFLOW_PATH }] },
      refFiles: { [HEAD_SHA]: { [RUNNER_WORKFLOW_PATH]: TEXT } },
    },
  },
};

describe('readActionsSetupPull', () => {
  let client: GitHubClient;
  const paths: string[] = [];

  beforeAll(async () => {
    const mock = await createMockGitHub(FIXTURES);
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      paths.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);
      return mock.fetch(input, init);
    };
    const auth = new GitHubAppAuth(mock.credentials, { fetch });
    client = new GitHubClient(fetch, auth.tokenSourceFor(parseRepoName(REPO)));
  });

  beforeEach(() => {
    paths.length = 0;
  });

  it('finds the PR from <repository owner>:<branch>, never the fork’s of the same branch name', async () => {
    const found = await readActionsSetupPull(client, parseRepoName(REPO), BRANCH);
    expect(found).toMatchObject({
      number: 5,
      htmlUrl: `https://github.com/${REPO}/pull/5`,
      author: { login: BOT, type: 'Bot' },
      headRepositoryId: REPO_ID,
      baseRepositoryId: REPO_ID,
      commits: 1,
      changedFiles: 1,
      files: [RUNNER_WORKFLOW_PATH],
    });
    expect(found?.headFile?.kind).toBe('file');
    expect(paths.some((path) => path.includes(`head=acme%3A${encodeURIComponent(BRANCH)}`))).toBe(true);
    // Only reads: no PR, branch or file is written.
    expect(paths.every((path) => path.startsWith('GET ') || path.includes('/access_tokens'))).toBe(true);
  });

  it('answers null when no PR is open from the branch', async () => {
    await expect(
      readActionsSetupPull(client, parseRepoName(REPO), 'team-console/runner-ffffffffffff'),
    ).resolves.toBeNull();
  });
});

describe('readSetupBranches (#870)', () => {
  let refs: () => Response;
  let client: GitHubClient;
  const paths: string[] = [];

  beforeAll(async () => {
    const mock = await createMockGitHub(FIXTURES);
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      if (url.pathname.includes('/git/matching-refs/')) {
        paths.push(`${init.method ?? 'GET'} ${url.pathname}`);
        return refs();
      }
      return mock.fetch(input, init);
    };
    const auth = new GitHubAppAuth(mock.credentials, { fetch });
    client = new GitHubClient(fetch, auth.tokenSourceFor(parseRepoName(REPO)));
  });

  beforeEach(() => {
    paths.length = 0;
  });

  const answer = (status: number, body: unknown) => (): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('reads the refs under the setup prefix and keeps only exact setup branch names', async () => {
    refs = answer(200, [
      { ref: `refs/heads/${BRANCH}` },
      { ref: 'refs/heads/team-console/runner-0123456789ab-extra' },
      { ref: 'refs/heads/team-console/runner-XYZ' },
      { ref: 'refs/tags/team-console/runner-aaaaaaaaaaaa' },
      { ref: 42 },
      'not a ref',
      { ref: 'refs/heads/team-console/runner-ffffffffffff' },
    ]);
    await expect(readSetupBranches(client, parseRepoName(REPO))).resolves.toEqual([
      BRANCH,
      'team-console/runner-ffffffffffff',
    ]);
    expect(paths).toEqual([`GET /repos/${REPO}/git/matching-refs/heads/team-console/runner-`]);
  });

  it(`keeps at most ${String(SETUP_BRANCHES_MAX)} branches`, async () => {
    const many = Array.from({ length: SETUP_BRANCHES_MAX + 5 }, (_, index) => ({
      ref: `refs/heads/team-console/runner-${index.toString(16).padStart(12, '0')}`,
    }));
    refs = answer(200, many);
    await expect(readSetupBranches(client, parseRepoName(REPO))).resolves.toHaveLength(SETUP_BRANCHES_MAX);
  });

  it('answers none on GitHub’s 404', async () => {
    refs = answer(404, { message: 'Not Found' });
    await expect(readSetupBranches(client, parseRepoName(REPO))).resolves.toEqual([]);
  });

  it('throws any other failure, so the check answers github-unavailable instead of a guess', async () => {
    refs = answer(503, { message: 'Service Unavailable' });
    await expect(readSetupBranches(client, parseRepoName(REPO))).rejects.toThrow();
  });

  it('throws on an answer that is not a list', async () => {
    refs = answer(200, { ref: `refs/heads/${BRANCH}` });
    await expect(readSetupBranches(client, parseRepoName(REPO))).rejects.toThrow();
  });
});

describe('judgePullProvenance', () => {
  const rendering = new TextEncoder().encode(TEXT);
  const expected = { repositoryId: REPO_ID, botLogin: BOT, rendering };
  const consoles: ActionsSetupPull = {
    number: 5,
    htmlUrl: `https://github.com/${REPO}/pull/5`,
    author: { login: BOT, type: 'Bot' },
    headRepositoryId: REPO_ID,
    baseRepositoryId: REPO_ID,
    commits: 1,
    changedFiles: 1,
    files: [RUNNER_WORKFLOW_PATH],
    headFile: { kind: 'file', bytes: rendering },
  };

  it('is console only for the app’s bot, in the project’s repository, one commit with the rendering', () => {
    expect(judgePullProvenance(consoles, expected)).toBe('console');
    expect(
      judgePullProvenance({ ...consoles, author: { login: BOT.toUpperCase(), type: 'Bot' } }, expected),
    ).toBe('console');
  });

  it.each<[string, Partial<ActionsSetupPull>]>([
    ['a person with the bot’s login', { author: { login: BOT, type: 'User' } }],
    ['another bot', { author: { login: 'renovate[bot]', type: 'Bot' } }],
    ['no author', { author: null }],
    ['a head in another repository', { headRepositoryId: 1 }],
    ['a base in another repository', { baseRepositoryId: 1 }],
  ])('is foreign for %s', (_case, patch) => {
    expect(judgePullProvenance({ ...consoles, ...patch }, expected)).toBe('foreign');
  });

  it('is foreign when the app’s bot login is unknown', () => {
    expect(judgePullProvenance(consoles, { ...expected, botLogin: null })).toBe('foreign');
  });

  it.each<[string, Partial<ActionsSetupPull>]>([
    ['a second commit', { commits: 2 }],
    ['a second file', { changedFiles: 2, files: [] }],
    ['another file', { files: ['README.md'] }],
    ['other bytes', { headFile: { kind: 'file', bytes: new TextEncoder().encode(`${TEXT} `) } }],
    ['the file gone', { headFile: { kind: 'missing' } }],
    ['a file too large', { headFile: { kind: 'too-large' } }],
    ['the file not read', { headFile: null }],
  ])('is changed for the console’s PR with %s', (_case, patch) => {
    expect(judgePullProvenance({ ...consoles, ...patch }, expected)).toBe('changed');
  });
});

describe('sameWorkflowBytes', () => {
  it('compares byte for byte, length first', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(sameWorkflowBytes(encode('abc'), encode('abc'))).toBe(true);
    expect(sameWorkflowBytes(encode('abc'), encode('abd'))).toBe(false);
    expect(sameWorkflowBytes(encode('abc'), encode('abc\n'))).toBe(false);
  });
});
