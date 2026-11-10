import {
  GitHubAppAuth,
  MOCK_FIXTURES,
  createMockGitHub,
  requestBudgetError,
  type FetchLike,
  type MockFixtures,
} from '@worker/github';
import { VcsError, type RepoRef } from '@worker/vcs';
import { GitHubVcsAdapter } from './adapter';

// #463 against @worker/github's mock GitHub: the real app flow (JWT, installation lookup, read-only per-repository
// mint) with only the transport faked. Every read and every refusal of the adapter.

const EDGE = 'geeera/vcs-edge';
const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const edgeFixtures: MockFixtures = {
  repositories: {
    ...MOCK_FIXTURES.repositories,
    [EDGE]: {
      installationId: 1001,
      repository: {
        id: 900077,
        full_name: EDGE,
        private: true,
        default_branch: 'main',
        html_url: `https://github.com/${EDGE}`,
        owner: { login: 'geeera', id: 100001 },
      },
      files: { 'big.txt': 'x'.repeat(64), 'bin.dat': 'ÿ' },
      pulls: [
        {
          id: 77,
          number: 7,
          title: 'A pull request with an unexpected shape',
          state: 'open',
          updated_at: '2026-11-01T00:00:00Z',
          head: { ref: 'feature/x', sha: 'not-a-sha' },
          base: { ref: 'main' },
        },
      ],
    },
  },
};

interface Harness {
  readonly adapter: GitHubVcsAdapter;
  /** Requests that were not the app's own (installation lookup, mint). */
  readonly reads: () => string[];
}

async function harness(world: MockFixtures = edgeFixtures): Promise<Harness> {
  const mock = await createMockGitHub(world);
  const calls: string[] = [];
  const counted: FetchLike = async (input, init) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(input).pathname}${new URL(input).search}`);
    return mock.fetch(input, init);
  };
  const auth = new GitHubAppAuth(mock.credentials, { fetch: mock.fetch });
  return {
    adapter: new GitHubVcsAdapter({ fetch: counted, auth }),
    reads: () => calls.filter((call) => call.startsWith('GET /repos/') && !call.endsWith('/installation')),
  };
}

const ref = (fullName: string, externalId: string | null = null): RepoRef => {
  const [owner = '', name = ''] = fullName.split('/');
  return { provider: 'github', owner, name, externalId };
};

const TC = ref('geeera/team-console', '900001');

async function vcsError(promise: Promise<unknown>): Promise<VcsError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof VcsError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a VcsError');
}

describe('GitHubVcsAdapter reads', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });

  it('describes the provider', () => {
    expect(h.adapter.provider).toBe('github');
    expect(h.adapter.capabilities()).toEqual({
      mergeMethods: ['merge', 'squash', 'rebase'],
      draft: true,
      checkRuns: true,
      fileSizeLimit: 1024 * 1024,
    });
  });

  it('reads the repository, with its page built from the name', async () => {
    await expect(h.adapter.repository(TC)).resolves.toEqual({
      externalId: '900001',
      fullName: 'geeera/team-console',
      defaultBranch: 'dev',
      visibility: 'public',
      htmlUrl: 'https://github.com/geeera/team-console',
    });
    await expect(h.adapter.repository(ref(EDGE))).resolves.toMatchObject({ visibility: 'private' });
  });

  it('refuses a repository whose id is no longer the registered one (409 vcs-repository-changed)', async () => {
    const error = await vcsError(h.adapter.repository(ref('geeera/team-console', '123')));
    expect(error.kind).toBe('conflict');
    expect(error.problem).toMatchObject({ type: 'vcs-repository-changed', status: 409 });
  });

  it('reads a branch, null for one that does not exist or is not a branch name', async () => {
    const branch = await h.adapter.branches.get(TC, 'dev');
    expect(branch).toMatchObject({ name: 'dev', protected: false });
    expect(branch?.sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(h.adapter.branches.get(TC, 'nope')).resolves.toBeNull();
    const before = h.reads().length;
    await expect(h.adapter.branches.get(TC, '../../issues')).resolves.toBeNull();
    expect(h.reads().length, 'an invalid name is never sent').toBe(before);
  });

  it('lists branches one page at a time', async () => {
    const page = await h.adapter.branches.list(TC);
    expect(page.items.map((branch) => branch.name)).toEqual(['dev']);
    expect(page.nextPage).toBeNull();
    expect(h.reads().at(-1)).toBe('GET /repos/geeera/team-console/branches?per_page=30&page=1');
  });

  it('reads a file at a revision as bytes and text', async () => {
    const file = await h.adapter.files.read(TC, '.product-team/project.yml', 'dev', 64 * 1024);
    expect(file).not.toBe('not-found');
    expect(file).not.toBe('too-large');
    if (typeof file === 'string') {
      return;
    }
    expect(file.path).toBe('.product-team/project.yml');
    expect(file.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(file.text).toContain('name: Team Console');
    expect(file.bytes.byteLength).toBe(file.size);
    expect(h.reads().at(-1)).toBe(
      'GET /repos/geeera/team-console/contents/.product-team/project.yml?ref=dev',
    );
  });

  it('answers not-found for a missing path or a directory, too-large past max', async () => {
    await expect(h.adapter.files.read(TC, 'no/such.md', 'dev', 1024)).resolves.toBe('not-found');
    await expect(h.adapter.files.read(TC, '.product-team', 'dev', 1024)).resolves.toBe('not-found');
    await expect(h.adapter.files.read(ref(EDGE), 'big.txt', 'main', 63)).resolves.toBe('too-large');
    await expect(h.adapter.files.read(ref(EDGE), 'big.txt', 'main', 64)).resolves.toMatchObject({ size: 64 });
    await expect(h.adapter.files.read(ref(EDGE), 'bin.dat', 'main', 64)).resolves.toMatchObject({
      size: 2,
      text: '\u00ff',
    });
  });

  it('refuses a traversal, an empty segment or a bad revision before any request', async () => {
    const before = h.reads().length;
    await expect(h.adapter.files.read(TC, '../secrets', 'dev', 10)).rejects.toThrow();
    await expect(h.adapter.files.read(TC, 'docs//x', 'dev', 10)).rejects.toThrow();
    await expect(h.adapter.files.read(TC, 'a.md', 'dev?x=1', 10)).rejects.toThrow(RangeError);
    await expect(h.adapter.files.read(TC, 'a.md', 'dev', -1)).rejects.toThrow(RangeError);
    expect(h.reads().length).toBe(before);
  });

  it('reads one pull request whatever its state, null for an unknown number', async () => {
    await expect(h.adapter.pullRequests.get(TC, 92)).resolves.toEqual({
      externalId: '920001',
      number: 92,
      title: 'feat(#131): CI state for each open pull request on the board',
      state: 'open',
      draft: false,
      headRef: 'feature/board-ci-state',
      headSha: '92b1ab0092b1ab0092b1ab0092b1ab0092b1ab00',
      baseRef: 'dev',
      headRepository: 'geeera/team-console',
      authorLogin: 'geeera',
      url: 'https://github.com/geeera/team-console/pull/92',
      updatedAt: '2026-10-03T12:00:00.000Z',
    });
    await expect(h.adapter.pullRequests.get(TC, 38)).resolves.toMatchObject({ state: 'merged' });
    await expect(h.adapter.pullRequests.get(TC, 9999)).resolves.toBeNull();
    await expect(h.adapter.pullRequests.get(TC, 0)).rejects.toThrow(RangeError);
  });

  it('lists pull requests by state and base, one page, with the next page when GitHub names one', async () => {
    const open = await h.adapter.pullRequests.list(TC, { state: 'open' }, { perPage: 2 });
    expect(open.items.map((pull) => pull.number)).toEqual([176, 92]);
    expect(open.nextPage).toBe(2);
    const last = await h.adapter.pullRequests.list(TC, { state: 'open' }, { perPage: 2, page: 3 });
    expect(last.items.map((pull) => pull.number)).toEqual([40]);
    expect(last.nextPage).toBeNull();
    const closed = await h.adapter.pullRequests.list(TC, { state: 'closed', base: 'dev' });
    expect(closed.items.map((pull) => [pull.number, pull.state])).toEqual([[38, 'merged']]);
    await expect(h.adapter.pullRequests.list(TC, { state: 'all', base: 'main' })).resolves.toEqual({
      items: [],
      nextPage: null,
    });
    expect(h.reads().at(-1)).toBe(
      'GET /repos/geeera/team-console/pulls?state=all&base=main&per_page=30&page=1',
    );
  });

  it('refuses a page size past 100 and a bad base before any request', async () => {
    const before = h.reads().length;
    await expect(h.adapter.pullRequests.list(TC, { state: 'open' }, { perPage: 101 })).rejects.toThrow(
      RangeError,
    );
    await expect(h.adapter.pullRequests.list(TC, { state: 'open' }, { page: 0 })).rejects.toThrow(RangeError);
    await expect(h.adapter.pullRequests.list(TC, { state: 'open', base: 'a..b' })).rejects.toThrow(
      RangeError,
    );
    expect(h.reads().length).toBe(before);
  });

  it('lists the changed files of a pull request', async () => {
    const page = await h.adapter.pullRequests.files(TC, 92, { perPage: 100 });
    expect(page.items).toEqual([
      {
        path: 'libs/worker/read-models/src/lib/ci-state.ts',
        previousPath: null,
        status: 'added',
        additions: 80,
        deletions: 0,
      },
      {
        path: 'apps/api/src/read-models/project-reads.ts',
        previousPath: null,
        status: 'modified',
        additions: 40,
        deletions: 3,
      },
      {
        path: 'apps/console/src/old-ci.ts',
        previousPath: 'apps/console/src/ci.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
    ]);
    await expect(h.adapter.pullRequests.files(TC, 91)).resolves.toEqual({ items: [], nextPage: null });
    expect((await vcsError(h.adapter.pullRequests.files(TC, 9999))).kind).toBe('not-found');
  });

  it("summarises a head's CI from its latest check runs", async () => {
    await expect(h.adapter.ci.status(TC, '92b1ab0092b1ab0092b1ab0092b1ab0092b1ab00')).resolves.toBe(
      'pending',
    );
    await expect(h.adapter.ci.status(TC, '45a1c0de45a1c0de45a1c0de45a1c0de45a1c0de')).resolves.toBe(
      'success',
    );
    await expect(h.adapter.ci.status(TC, '40fa11ed40fa11ed40fa11ed40fa11ed40fa11ed')).resolves.toBe(
      'failure',
    );
    await expect(h.adapter.ci.status(TC, SHA)).resolves.toBe('none');
    await expect(h.adapter.ci.status(TC, 'HEAD')).rejects.toThrow(RangeError);
  });

  it('answers 502 github-unexpected (unavailable) for an item GitHub sent in another shape', async () => {
    const error = await vcsError(h.adapter.pullRequests.get(ref(EDGE), 7));
    expect(error.kind).toBe('unavailable');
    expect(error.problem).toMatchObject({ type: 'github-unexpected', status: 502 });
  });

  it('is forbidden on a repository the app is not installed on (409 github-app-not-installed)', async () => {
    const error = await vcsError(h.adapter.repository(ref('geeera/not-installed')));
    expect(error.kind).toBe('forbidden');
    expect(error.problem.type).toBe('github-app-not-installed');
  });

  it('refuses a ref of another provider', async () => {
    await expect(h.adapter.repository({ ...TC, provider: 'gitlab' })).rejects.toThrow(TypeError);
  });
});

describe('GitHubVcsAdapter error kinds', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });

  it.each([
    ['geeera/mock-rate-limited', 'rate-limited', 'github-rate-limit', 429],
    ['geeera/mock-unavailable', 'unavailable', 'github-unavailable', 502],
    ['geeera/mock-redirect-off-host', 'unavailable', 'github-unexpected', 502],
  ] as const)('%s → %s (%s %d)', async (repo, kind, type, status) => {
    const error = await vcsError(h.adapter.pullRequests.list(ref(repo), { state: 'open' }));
    expect(error.kind).toBe(kind);
    expect(error.problem).toMatchObject({ type, status });
  });

  it('keeps the rate limit wait', async () => {
    const error = await vcsError(h.adapter.repository(ref('geeera/mock-rate-limited')));
    expect(error.retryAfter).toBe(42);
  });

  it('is forbidden when GitHub keeps refusing the token', async () => {
    const error = await vcsError(h.adapter.repository(ref('geeera/mock-token-rejected')));
    expect(error.kind).toBe('forbidden');
    expect(error.problem.type).toBe('github-auth');
  });

  it('answers github-unexpected for a next link off api.github.com, never a last page (#481)', async () => {
    const mock = await createMockGitHub(edgeFixtures);
    const auth = new GitHubAppAuth(mock.credentials, { fetch: mock.fetch });
    const adapter = new GitHubVcsAdapter({
      auth,
      fetch: async (input, init) => {
        const response = await mock.fetch(input, init);
        const link = response.headers.get('link');
        if (link === null) {
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set('link', link.replace('https://api.github.com', 'https://evil.example'));
        return new Response(response.body, { status: response.status, headers });
      },
    });
    const error = await vcsError(adapter.pullRequests.list(TC, { state: 'open' }, { perPage: 2 }));
    expect(error.kind).toBe('unavailable');
    expect(error.problem).toMatchObject({ type: 'github-unexpected', status: 502 });
    // The page with no next link at all is still the last one.
    await expect(
      adapter.pullRequests.list(TC, { state: 'open' }, { perPage: 2, page: 3 }),
    ).resolves.toMatchObject({
      nextPage: null,
    });
  });

  it('passes a budget that refuses as unavailable, without a request', async () => {
    const mock = await createMockGitHub(edgeFixtures);
    const auth = new GitHubAppAuth(mock.credentials, { fetch: mock.fetch });
    let sent = 0;
    const adapter = new GitHubVcsAdapter({
      auth,
      fetch: async (input, init) => {
        if (new URL(input).pathname.startsWith('/repos/geeera/team-console/pulls')) {
          throw requestBudgetError();
        }
        sent += 1;
        return mock.fetch(input, init);
      },
    });
    const error = await vcsError(adapter.pullRequests.list(TC, { state: 'open' }));
    expect(error.kind).toBe('unavailable');
    expect(error.problem.type).toBe('github-request-budget');
    expect(sent).toBe(0);
  });
});

describe('GitHubVcsAdapter writes (until #309 3b)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });

  it.each([
    [
      'pullRequests.create',
      (a: GitHubVcsAdapter) =>
        a.pullRequests.create(TC, { head: 'feature/x', base: 'dev', title: 't', body: 'b' }),
    ],
    ['pullRequests.updateBranch', (a: GitHubVcsAdapter) => a.pullRequests.updateBranch(TC, 92)],
    ['pullRequests.comment', (a: GitHubVcsAdapter) => a.pullRequests.comment(TC, 92, 'hello')],
    [
      'pullRequests.merge',
      (a: GitHubVcsAdapter) => a.pullRequests.merge(TC, 92, { method: 'squash', expectedHeadSha: SHA }),
    ],
    ['credentials.gitToken', (a: GitHubVcsAdapter) => a.credentials.gitToken(TC, 'write', 3600)],
  ] as const)('%s throws 403 vcs-write-forbidden and sends nothing', async (operation, call) => {
    const before = h.reads().length;
    const error = await vcsError(call(h.adapter));
    expect(error.kind).toBe('forbidden');
    expect(error.problem).toMatchObject({
      type: 'vcs-write-forbidden',
      status: 403,
      detail: `${operation} is not available yet`,
    });
    expect(h.reads().length).toBe(before);
  });
});
