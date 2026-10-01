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
import type { TokenSource } from './token-source';

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

function fixedTokens(token = 'ghs_fixed'): TokenSource & { invalidated: string[] } {
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
  function ownerTokens(): TokenSource & { invalidated: string[]; issued: number } {
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
