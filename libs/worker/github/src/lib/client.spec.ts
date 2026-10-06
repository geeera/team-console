import {
  SENTINEL_TOKEN,
  appFlow,
  generateAppKey,
  json,
  scriptedGitHub,
  type AppKey,
} from '../testing/github-kit';
import { GitHubAppAuth } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { githubPath } from './github-path';
import { parseRepoName } from './repo-name';
import type { InstallationListTokenSource, RequestTokenSource } from './token-source';

const REPO = parseRepoName('geeera/team-console');

interface Repo {
  full_name: string;
}
const isRepo = (value: unknown): value is Repo =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['full_name'] === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

let key: AppKey;

beforeAll(async () => {
  key = await generateAppKey();
});

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

function fixedTokens(token = 'ghs_fixed'): RequestTokenSource & { invalidated: string[] } {
  const invalidated: string[] = [];
  return {
    kind: 'installation',
    invalidated,
    getToken: async () => token,
    invalidate: (value) => invalidated.push(value),
  };
}

describe('GitHubClient.getJson', () => {
  it('reads with the token source and narrows with the guard', async () => {
    const github = scriptedGitHub(() => json(200, { full_name: 'geeera/team-console', extra: 1 }));
    const client = new GitHubClient(github.fetch, fixedTokens());

    await expect(client.getJson(githubPath`/repos/${REPO}`, isRepo)).resolves.toMatchObject({
      full_name: 'geeera/team-console',
    });
    expect(github.calls[0]?.headers.get('authorization')).toBe('Bearer ghs_fixed');
  });

  it('answers 502 github-unexpected when the body does not pass the guard', async () => {
    const github = scriptedGitHub(() => json(200, { name: 'x' }));
    const error = await rejection(
      new GitHubClient(github.fetch, fixedTokens()).getJson(githubPath`/x`, isRepo),
    );
    expect(error.problem).toMatchObject({ type: 'github-unexpected', status: 502 });
  });

  it('answers 502 github-unexpected when the body is not JSON', async () => {
    const github = scriptedGitHub(() => new Response('<html>', { status: 200 }));
    const error = await rejection(
      new GitHubClient(github.fetch, fixedTokens()).getJson(githubPath`/x`, isRepo),
    );
    expect(error.problem.type).toBe('github-unexpected');
  });

  it.each([
    [403, {}, 'github-auth', 503],
    [404, {}, 'github-not-found', 404],
    [429, { 'retry-after': '5' }, 'github-rate-limit', 429],
    [503, {}, 'github-unavailable', 502],
    [418, {}, 'github-unexpected', 502],
  ] as const)('maps GitHub %i to %s', async (status, headers, type, problemStatus) => {
    const github = scriptedGitHub(() => json(status, { message: 'x' }, headers));
    const error = await rejection(
      new GitHubClient(github.fetch, fixedTokens()).getJson(githubPath`/x`, isRepo),
    );
    expect(error.problem).toMatchObject({ type, status: problemStatus });
  });

  it('evicts a cached installation token on 401 and retries once with a fresh one', async () => {
    let reads = 0;
    const github = appFlow(() => {
      reads += 1;
      return reads === 1
        ? json(401, { message: 'Bad credentials' })
        : json(200, { full_name: 'geeera/team-console' });
    });
    const auth = new GitHubAppAuth({ appId: '1', privateKeyPem: key.pem }, { fetch: github.fetch });
    const client = new GitHubClient(github.fetch, auth.tokenSourceFor(REPO));

    await expect(client.getJson(githubPath`/repos/${REPO}`, isRepo)).resolves.toBeDefined();

    const readAuth = github.calls
      .filter((call) => new URL(call.url).pathname === '/repos/geeera/team-console')
      .map((call) => call.headers.get('authorization'));
    expect(readAuth).toEqual([`Bearer ${SENTINEL_TOKEN}1`, `Bearer ${SENTINEL_TOKEN}2`]);
    expect(github.minted()).toBe(2);
  });

  it('gives up after one retry: a second 401 → 503 github-auth', async () => {
    const tokens = fixedTokens();
    const github = scriptedGitHub(() => json(401, { message: 'Bad credentials' }));
    const error = await rejection(new GitHubClient(github.fetch, tokens).getJson(githubPath`/x`, isRepo));
    expect(error.problem).toMatchObject({ type: 'github-auth', status: 503 });
    expect(github.calls).toHaveLength(2);
    expect(tokens.invalidated).toEqual(['ghs_fixed']);
  });
});

describe('GitHubClient.postJson', () => {
  const isComment = (value: unknown): value is { id: number } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['id'] === 'number';

  /** An owner source whose tokens rotate on every refresh, like #59's connection. */
  function ownerTokens(): RequestTokenSource & { invalidated: string[]; issued: number } {
    const state = { invalidated: [] as string[], issued: 0 };
    return {
      kind: 'owner',
      get invalidated() {
        return state.invalidated;
      },
      get issued() {
        return state.issued;
      },
      getToken: async () => {
        state.issued += 1;
        return `owner-${state.issued}`;
      },
      invalidate: (value) => state.invalidated.push(value),
    };
  }

  const PATH = githubPath`/repos/${REPO}/issues/${7}/comments`;

  it('posts the JSON body with the source token and narrows the answer', async () => {
    const github = scriptedGitHub(() => json(201, { id: 99, html_url: 'https://github.com/x' }));
    await expect(
      new GitHubClient(github.fetch, ownerTokens()).postJson(PATH, { body: 'hi' }, isComment),
    ).resolves.toMatchObject({ id: 99 });
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]).toMatchObject({ method: 'POST', body: '{"body":"hi"}', redirect: 'manual' });
    expect(github.calls[0]?.headers.get('authorization')).toBe('Bearer owner-1');
    expect(github.calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('refreshes once on 401 and sends again with the new token', async () => {
    const tokens = ownerTokens();
    const github = scriptedGitHub((call) =>
      call.headers.get('authorization') === 'Bearer owner-1'
        ? json(401, { message: 'Bad credentials' })
        : json(201, { id: 1 }),
    );
    await expect(new GitHubClient(github.fetch, tokens).postJson(PATH, {}, isComment)).resolves.toEqual({
      id: 1,
    });
    expect(tokens.invalidated).toEqual(['owner-1']);
    expect(github.calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer owner-1',
      'Bearer owner-2',
    ]);
  });

  it('answers 403 github-owner-not-connected when the refreshed owner token is refused too', async () => {
    const github = scriptedGitHub(() => json(401, { message: 'Bad credentials' }));
    const error = await rejection(
      new GitHubClient(github.fetch, ownerTokens()).postJson(PATH, {}, isComment),
    );
    expect(error.problem).toMatchObject({
      type: 'github-owner-not-connected',
      status: 403,
      extensions: { connectUrl: '/api/v1/github/connect' },
    });
    expect(github.calls).toHaveLength(2);
  });

  it.each([
    ['a 5xx', () => json(502, { message: 'bad gateway' }), 'github-unavailable'],
    [
      'a timeout or network failure',
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      'github-unavailable',
    ],
    ['a rate limit', () => json(403, {}, { 'retry-after': '60' }), 'github-rate-limit'],
  ] as const)('never sends the write again after %s', async (_, reply, type) => {
    const github = scriptedGitHub(reply);
    const error = await rejection(
      new GitHubClient(github.fetch, ownerTokens()).postJson(PATH, {}, isComment),
    );
    expect(error.problem.type).toBe(type);
    expect(github.calls).toHaveLength(1);
  });

  it('never follows a redirect on a write', async () => {
    const github = scriptedGitHub(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://api.github.com/repos/a/b/issues/7/comments' },
        }),
    );
    const error = await rejection(
      new GitHubClient(github.fetch, ownerTokens()).postJson(PATH, {}, isComment),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(1);
  });

  describe('delete (#114)', () => {
    const LABEL = githubPath`/repos/${REPO}/issues/${22}/labels/${'team:paused'}`;

    it('sends one DELETE without a body and refreshes once on 401', async () => {
      const tokens = ownerTokens();
      const github = scriptedGitHub((call) =>
        call.headers.get('authorization') === 'Bearer owner-1'
          ? json(401, { message: 'Bad credentials' })
          : json(200, []),
      );
      await new GitHubClient(github.fetch, tokens).delete(LABEL);
      expect(github.calls.map((call) => [call.method, call.body])).toEqual([
        ['DELETE', undefined],
        ['DELETE', undefined],
      ]);
      expect(new URL(github.calls[0]?.url ?? '').pathname).toBe(
        '/repos/geeera/team-console/issues/22/labels/team%3Apaused',
      );
    });

    it('answers github-not-found for a label that is not there, and never repeats after a 5xx', async () => {
      const missing = await rejection(
        new GitHubClient(scriptedGitHub(() => json(404, {})).fetch, ownerTokens()).delete(LABEL),
      );
      expect(missing.problem.type).toBe('github-not-found');
      const github = scriptedGitHub(() => json(503, {}));
      const down = await rejection(new GitHubClient(github.fetch, ownerTokens()).delete(LABEL));
      expect(down.problem.type).toBe('github-unavailable');
      expect(github.calls).toHaveLength(1);
    });
  });
});

describe('GitHubClient.paginate', () => {
  function pages(links: Record<string, string | undefined>, bodies: Record<string, unknown>) {
    return scriptedGitHub((call) => {
      const url = new URL(call.url);
      const key = `${url.pathname}${url.search}`;
      const link = links[key];
      return json(200, bodies[key] ?? [], link === undefined ? {} : { link });
    });
  }

  it('follows rel="next" and concatenates the pages', async () => {
    const github = pages(
      {
        '/items?per_page=2':
          '<https://api.github.com/items?per_page=2&page=2>; rel="next", <https://api.github.com/items?per_page=2&page=3>; rel="last"',
        '/items?per_page=2&page=2': '<https://api.github.com/items?per_page=2&page=3>; rel="next"',
      },
      { '/items?per_page=2': [1, 2], '/items?per_page=2&page=2': [3, 4], '/items?per_page=2&page=3': [5] },
    );
    const items = await new GitHubClient(github.fetch, fixedTokens()).paginate(
      githubPath`/items?per_page=${2}`,
      isNumber,
    );
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops at maxPages (subrequest budget)', async () => {
    const github = scriptedGitHub((call) =>
      json(200, [1], { link: `<${call.url.split('?')[0]}?page=${Math.random()}>; rel="next"` }),
    );
    const items = await new GitHubClient(github.fetch, fixedTokens()).paginate(githubPath`/items`, isNumber, {
      maxPages: 3,
    });
    expect(items).toHaveLength(3);
    expect(github.calls).toHaveLength(3);
  });

  it('never follows a next link off api.github.com', async () => {
    const github = pages({ '/items': '<https://evil.example/items?page=2>; rel="next"' }, { '/items': [1] });
    const items = await new GitHubClient(github.fetch, fixedTokens()).paginate(githubPath`/items`, isNumber);
    expect(items).toEqual([1]);
    expect(github.calls).toHaveLength(1);
  });

  it('follows rel="next" when the header lists rel="last" first', async () => {
    const github = pages(
      {
        '/items':
          '<https://api.github.com/items?page=2>; rel="last", <https://api.github.com/items?page=2>; rel="next"',
      },
      { '/items': [1], '/items?page=2': [2] },
    );
    const items = await new GitHubClient(github.fetch, fixedTokens()).paginate(githubPath`/items`, isNumber);
    expect(items).toEqual([1, 2]);
  });

  it('refuses a page that is not an array, or an item of the wrong shape', async () => {
    const notArray = scriptedGitHub(() => json(200, { items: [] }));
    expect(
      (await rejection(new GitHubClient(notArray.fetch, fixedTokens()).paginate(githubPath`/x`, isNumber)))
        .problem.type,
    ).toBe('github-unexpected');
    const badItem = scriptedGitHub(() => json(200, [1, 'two']));
    expect(
      (await rejection(new GitHubClient(badItem.fetch, fixedTokens()).paginate(githubPath`/x`, isNumber)))
        .problem.type,
    ).toBe('github-unexpected');
  });
});

describe('GitHubClient.lastPage', () => {
  const anyList = (): boolean => true;
  const eventsOnly = (url: URL): boolean => url.pathname === '/events';

  function pages(links: Record<string, string | undefined>, bodies: Record<string, unknown>) {
    return scriptedGitHub((call) => {
      const url = new URL(call.url);
      const key = `${url.pathname}${url.search}`;
      const link = links[key];
      return json(200, bodies[key] ?? [], link === undefined ? {} : { link });
    });
  }

  it('answers the only page as the whole list in one request', async () => {
    const github = pages({}, { '/events?per_page=100': [1, 2, 3] });
    const tail = await new GitHubClient(github.fetch, fixedTokens()).lastPage(
      githubPath`/events?per_page=${100}`,
      isNumber,
      eventsOnly,
    );
    expect(tail).toEqual({ items: [1, 2, 3], isWholeList: true });
    expect(github.calls).toHaveLength(1);
  });

  it('jumps to rel="last" and never reads the pages in between (two requests)', async () => {
    const github = pages(
      {
        '/events?per_page=2':
          '<https://api.github.com/events?per_page=2&page=2>; rel="next", <https://api.github.com/events?per_page=2&page=9>; rel="last"',
      },
      { '/events?per_page=2': [1, 2], '/events?per_page=2&page=9': [17] },
    );
    const tail = await new GitHubClient(github.fetch, fixedTokens()).lastPage(
      githubPath`/events?per_page=${2}`,
      isNumber,
      eventsOnly,
    );
    expect(tail).toEqual({ items: [17], isWholeList: false });
    expect(github.calls.map((call) => new URL(call.url).search)).toEqual([
      '?per_page=2',
      '?per_page=2&page=9',
    ]);
  });

  it('refuses a last page off api.github.com instead of answering an older tail', async () => {
    const github = pages(
      { '/events': '<https://evil.example/events?page=2>; rel="last"' },
      { '/events': [1] },
    );
    const error = await rejection(
      new GitHubClient(github.fetch, fixedTokens()).lastPage(githubPath`/events`, isNumber, anyList),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(1);
  });

  it('refuses a last page on api.github.com that the caller does not accept as the same list', async () => {
    const github = pages(
      { '/events': '<https://api.github.com/other/list?page=2>; rel="last"' },
      { '/events': [1], '/other/list?page=2': [99] },
    );
    const seen: string[] = [];
    const error = await rejection(
      new GitHubClient(github.fetch, fixedTokens()).lastPage(githubPath`/events`, isNumber, (url) => {
        seen.push(url.href);
        return eventsOnly(url);
      }),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(seen).toEqual(['https://api.github.com/other/list?page=2']);
    expect(github.calls).toHaveLength(1);
  });

  it('refuses an item of the wrong shape and passes a GitHub error through', async () => {
    const badItem = scriptedGitHub(() => json(200, [1, 'two']));
    expect(
      (
        await rejection(
          new GitHubClient(badItem.fetch, fixedTokens()).lastPage(githubPath`/x`, isNumber, anyList),
        )
      ).problem.type,
    ).toBe('github-unexpected');
    const missing = scriptedGitHub(() => json(404, { message: 'Not Found' }));
    expect(
      (
        await rejection(
          new GitHubClient(missing.fetch, fixedTokens()).lastPage(githubPath`/x`, isNumber, anyList),
        )
      ).problem.type,
    ).toBe('github-not-found');
  });
});

describe('GitHubClient.paginateBounded', () => {
  it('says complete: false at the cap, with the items read so far', async () => {
    const github = scriptedGitHub((call) =>
      json(200, [1], { link: `<${call.url.split('?')[0]}?page=${github.calls.length + 1}>; rel="next"` }),
    );
    const list = await new GitHubClient(github.fetch, fixedTokens()).paginateBounded(
      githubPath`/items`,
      isNumber,
      {
        maxPages: 2,
      },
    );
    expect(list).toEqual({ items: [1, 1], complete: false });
    expect(github.calls).toHaveLength(2);
  });

  it('says complete: true when Link names no next page', async () => {
    const github = scriptedGitHub(() => json(200, [1, 2]));
    const list = await new GitHubClient(github.fetch, fixedTokens()).paginateBounded(
      githubPath`/items`,
      isNumber,
    );
    expect(list).toEqual({ items: [1, 2], complete: true });
  });
});

describe('the installation-list token source (#194, ADR 0003 decision 6 as amended)', () => {
  function listTokens(token = 'ghs_list'): InstallationListTokenSource & { invalidated: string[] } {
    const invalidated: string[] = [];
    return {
      kind: 'installation-list',
      installationId: 4242,
      invalidated,
      getToken: async () => token,
      invalidate: (value) => invalidated.push(value),
    };
  }

  /** Smuggles the list source past the type check, as a bug elsewhere could at run time. */
  const smuggled = (source: InstallationListTokenSource) => source as unknown as RequestTokenSource;

  const repoPage = (names: readonly string[], link?: string) =>
    json(
      200,
      {
        total_count: 999,
        repositories: names.map((name, id) => ({ id, full_name: name, private: id % 2 === 0 })),
      },
      link === undefined ? {} : { link },
    );

  it('a /repos/x/y read on an installation-list source throws with zero fetch calls', async () => {
    const github = scriptedGitHub(() => json(200, { full_name: 'x/y' }));
    const client = new GitHubClient(github.fetch, smuggled(listTokens()));
    await expect(client.getJson(githubPath`/repos/${parseRepoName('x/y')}`, isRepo)).rejects.toThrow(
      /refuses a installation-list token source/,
    );
    expect(github.calls).toHaveLength(0);
  });

  it.each([
    ['paginate', (client: GitHubClient) => client.paginate(githubPath`/repos/x/y/issues`, isNumber)],
    [
      'paginateBounded',
      (client: GitHubClient) => client.paginateBounded(githubPath`/repos/x/y/issues`, isNumber),
    ],
    [
      'lastPage',
      (client: GitHubClient) => client.lastPage(githubPath`/repos/x/y/issues`, isNumber, () => true),
    ],
    [
      'postJson',
      (client: GitHubClient) => client.postJson(githubPath`/repos/x/y/issues/1/comments`, {}, isRepo),
    ],
    ['delete', (client: GitHubClient) => client.delete(githubPath`/repos/x/y/issues/1/labels/a`)],
  ])('%s on an installation-list source throws a plain Error before any fetch', async (_name, call) => {
    const github = scriptedGitHub(() => json(200, []));
    const tokens = listTokens();
    const error: unknown = await call(new GitHubClient(github.fetch, smuggled(tokens))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubError);
    expect(github.calls).toHaveLength(0);
  });

  it('listInstallationRepositories refuses a per-repository source with zero fetch calls', async () => {
    const github = scriptedGitHub(() => repoPage(['geeera/a']));
    const perRepo = fixedTokens() as unknown as InstallationListTokenSource;
    await expect(
      GitHubClient.listInstallationRepositories(github.fetch, perRepo, { maxPages: 10 }),
    ).rejects.toThrow(/refuses a installation token source/);
    expect(github.calls).toHaveLength(0);
  });

  it('reads the fixed path with the list token: one page', async () => {
    const github = scriptedGitHub(() => repoPage(['geeera/a', 'geeera/b']));
    const list = await GitHubClient.listInstallationRepositories(github.fetch, listTokens(), {
      maxPages: 10,
    });
    expect(list).toEqual({
      items: [
        { fullName: 'geeera/a', private: true },
        { fullName: 'geeera/b', private: false },
      ],
      complete: true,
    });
    expect(github.calls.map((call) => call.url)).toEqual([
      'https://api.github.com/installation/repositories?per_page=100',
    ]);
    expect(github.calls[0]?.headers.get('authorization')).toBe('Bearer ghs_list');
  });

  it('follows Link through three pages, then stops at the end', async () => {
    const next = (page: number) =>
      `<https://api.github.com/installation/repositories?per_page=100&page=${page}>; rel="next"`;
    const github = scriptedGitHub((call) => {
      const page = Number(new URL(call.url).searchParams.get('page') ?? '1');
      return repoPage([`geeera/r${page}`], page < 3 ? next(page + 1) : undefined);
    });
    const pages: string[][] = [];
    const list = await GitHubClient.listInstallationRepositories(github.fetch, listTokens(), {
      maxPages: 10,
      onPage: (page) => pages.push(page.map((repo) => repo.fullName)),
    });
    expect(list.items.map((repo) => repo.fullName)).toEqual(['geeera/r1', 'geeera/r2', 'geeera/r3']);
    expect(list.complete).toBe(true);
    expect(pages).toEqual([['geeera/r1'], ['geeera/r2'], ['geeera/r3']]);
    expect(github.calls).toHaveLength(3);
  });

  it('stops at maxPages with complete: false', async () => {
    const github = scriptedGitHub((call) => {
      const page = Number(new URL(call.url).searchParams.get('page') ?? '1');
      return repoPage(
        [`geeera/r${page}`],
        `<https://api.github.com/installation/repositories?per_page=100&page=${page + 1}>; rel="next"`,
      );
    });
    const list = await GitHubClient.listInstallationRepositories(github.fetch, listTokens(), {
      maxPages: 10,
    });
    expect(list.items).toHaveLength(10);
    expect(list.complete).toBe(false);
    expect(github.calls).toHaveLength(10);
  });

  it.each([
    [
      'another API path on api.github.com',
      '<https://api.github.com/repos/geeera/a/collaborators>; rel="next"',
    ],
    ['another host', '<https://evil.example/installation/repositories?page=2>; rel="next"'],
    ['an extra query member', '<https://api.github.com/installation/repositories?page=2&path=x>; rel="next"'],
    [
      'a path that only starts like the list',
      '<https://api.github.com/installation/repositories/../x>; rel="next"',
    ],
  ])('refuses a next link to %s: github-unexpected, never followed', async (_label, link) => {
    const github = scriptedGitHub(() => repoPage(['geeera/a'], link));
    const error = await rejection(
      GitHubClient.listInstallationRepositories(github.fetch, listTokens(), { maxPages: 10 }),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(1);
  });

  it.each([
    ['an array instead of the page object', []],
    ['a repository without full_name', { repositories: [{ id: 1, private: false }] }],
    ['a full_name that is not owner/name', { repositories: [{ id: 1, full_name: 'a/b/c', private: false }] }],
    ['private that is not a boolean', { repositories: [{ id: 1, full_name: 'a/b', private: 'no' }] }],
  ])('answers 502 github-unexpected for %s', async (_label, body) => {
    const github = scriptedGitHub(() => json(200, body));
    const error = await rejection(
      GitHubClient.listInstallationRepositories(github.fetch, listTokens(), { maxPages: 10 }),
    );
    expect(error.problem.type).toBe('github-unexpected');
  });

  it('evicts the list token on 401 and retries once', async () => {
    let calls = 0;
    const github = scriptedGitHub(() => (calls++ === 0 ? json(401, {}) : repoPage(['geeera/a'])));
    const tokens = listTokens();
    const list = await GitHubClient.listInstallationRepositories(github.fetch, tokens, { maxPages: 1 });
    expect(list.items).toHaveLength(1);
    expect(tokens.invalidated).toEqual(['ghs_list']);
  });
});
