import { env } from 'cloudflare:test';
import { BATCH_ANSWER_MAX, isProblemDetails, problemSlugOf } from '@shared/contracts';
import { answerComment } from '@shared/owner-grammar';
import type { FakeGitHubOAuth } from '@worker/github/testing';
import { ApiGitHub } from '../github';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import {
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
  type StubGitHub,
} from '../testing/github-kit';
import { OWNER, fakeGitHub, parsedLogs, resetOwnerConnections, seedConnection } from '../testing/owner-kit';
import { REPLAY_WINDOW_MS } from '../owner/post-owner-answer';
import { BATCH_GITHUB_BUDGET } from './batch-answer';

// #220: POST /api/v1/projects/:slug/answers/batch, end to end through the Worker. The fake GitHub holds the owner's
// tokens and takes the comments; the stub answers the installation-token reads of each issue.

const REPO = 'geeera/team-console';
const PATH = '/api/v1/projects/tc/answers/batch';
const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
const SAID = 'Одобряю совет команды (пакетно, 2)';

interface Issue {
  readonly state?: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly ask?: string;
  readonly association?: string;
  readonly pullRequest?: boolean;
}

const APPROVE = '/approve to ship it (recommended) · /reject why';
const SCOPE = ['kind:question', 'owner:scope'];

const ISSUES: Record<number, Issue> = {
  // Safe: open scope questions from the team that recommend approving.
  1: { labels: SCOPE, ask: APPROVE },
  2: { labels: SCOPE, ask: '/approve — начинаем (рекомендую) · /reject что поменять' },
  3: { labels: SCOPE, ask: APPROVE },
  // Not safe, one reason each.
  10: { labels: ['kind:question', 'owner:money'], ask: APPROVE },
  11: { labels: ['kind:question', 'owner:release'], ask: APPROVE },
  12: { labels: ['kind:question', 'owner:legal'], ask: APPROVE },
  13: { labels: ['kind:question', 'owner:access'], ask: APPROVE },
  14: { labels: ['kind:question', 'owner:design'], ask: APPROVE },
  15: { labels: ['design:awaiting-approval', 'kind:feature'], ask: APPROVE },
  16: { labels: ['team:demo', 'kind:chore'], ask: '/go (recommended) · /no-go why' },
  17: { labels: SCOPE, ask: '/reject why to keep it (recommended) · /approve to drop it' },
  18: { labels: ['kind:question'], ask: APPROVE },
  19: { labels: SCOPE, ask: APPROVE, association: 'NONE' },
  20: { labels: SCOPE, ask: '/approve to ship it · /reject why' },
  21: { labels: ['kind:question', 'owner:scope', 'owner:money'], ask: APPROVE },
  // Not waiting, or not a question at all.
  30: { state: 'closed', labels: SCOPE, ask: APPROVE },
  31: { labels: ['needs:owner', 'kind:chore'], ask: 'Напиши «сделал»' },
  32: { labels: ['kind:feature'], ask: APPROVE },
  33: { labels: SCOPE, ask: APPROVE, pullRequest: true },
};

for (let number = 100; number < 100 + BATCH_ANSWER_MAX; number += 1) {
  ISSUES[number] = { labels: SCOPE, ask: APPROVE };
}

interface Harness {
  readonly fake: FakeGitHubOAuth;
  readonly stub: StubGitHub;
  readonly github: ApiGitHub;
  readonly logs: string[];
  clock: number;
  repoOwner: { login: string; id: number };
  /** Issues whose comment POST GitHub answers with this instead (a 502, a timeout). */
  readonly commentReplies: Map<number, () => Response>;
}

function toRequest(call: GitHubCall): Request {
  return new Request(call.url.href, {
    method: call.method,
    headers: call.headers,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
}

function issueJson(number: number, issue: Issue): Record<string, unknown> {
  const association = issue.association ?? 'CONTRIBUTOR';
  return {
    number,
    title: `Issue ${number}`,
    body:
      issue.ask === undefined
        ? 'No answer line.'
        : `**Your answer:** ${issue.ask}\n<!-- pt-ask -->\n\nWhy.\n`,
    html_url: `https://github.com/${REPO}/issues/${number}`,
    state: issue.state ?? 'open',
    labels: issue.labels.map((name) => ({ name })),
    author_association: association,
    user:
      association === 'NONE'
        ? { login: 'stranger', type: 'User' }
        : { login: 'team-console-team[bot]', type: 'Bot' },
    ...(issue.pullRequest === true ? { pull_request: { url: 'x' } } : {}),
  };
}

function harness(options: { instantSleep?: boolean } = {}): Harness {
  const fake = fakeGitHub({ tokenTag: 'TESTSENTINEL' });
  const h: Harness = {
    fake,
    logs: [],
    clock: Date.now(),
    repoOwner: { login: OWNER.login, id: OWNER.id },
    commentReplies: new Map(),
    stub: stubGitHub(async (call) => {
      const path = call.url.pathname;
      const comment = /^\/repos\/geeera\/team-console\/issues\/(\d+)\/comments$/.exec(path);
      if (call.method === 'POST' && comment !== null) {
        return h.commentReplies.get(Number(comment[1]))?.() ?? fake.handle(toRequest(call));
      }
      if (call.url.origin === 'https://github.com' || path === '/user') {
        return fake.handle(toRequest(call));
      }
      const issue = /^\/repos\/geeera\/team-console\/issues\/(\d+)$/.exec(path);
      if (call.method === 'GET' && issue !== null) {
        const number = Number(issue[1]);
        const found = ISSUES[number];
        return found === undefined
          ? json(404, { message: 'Not Found' })
          : json(200, issueJson(number, found));
      }
      if (call.method === 'GET' && path === `/repos/${REPO}`) {
        return json(200, { full_name: REPO, private: false, default_branch: 'dev', owner: h.repoOwner });
      }
      return json(404, { message: 'Not Found' });
    }),
    // Assigned right below: the stub's fetch needs `h` first.
    github: undefined as unknown as ApiGitHub,
  };
  Object.assign(h, {
    github: new ApiGitHub({
      fetch: h.stub.fetch,
      now: () => h.clock,
      ...(options.instantSleep === true ? { sleep: async () => undefined } : {}),
    }),
  });
  return h;
}

async function batch(
  h: Harness,
  body: unknown,
  options: { bindings?: ReturnType<typeof localEnv>; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetchApi(PATH, options.bindings ?? localEnv(), {
    method: 'POST',
    headers: options.headers ?? WRITE_HEADERS,
    body: JSON.stringify(body),
    github: h.github,
    logSink: (line) => h.logs.push(line),
  });
}

interface ItemResult {
  readonly number: number;
  readonly ok: boolean;
  readonly commentId?: number;
  readonly url?: string;
  readonly replayed?: boolean;
  readonly problem?: Record<string, unknown>;
}

async function resultsOf(response: Response): Promise<ItemResult[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { results: ItemResult[] };
  return body.results;
}

function slugOf(result: ItemResult | undefined): string | null {
  const problem = result?.problem;
  return isProblemDetails(problem) ? problemSlugOf(problem.type) : null;
}

function posts(h: Harness): GitHubCall[] {
  return h.stub.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/comments'));
}

function issueReads(h: Harness): GitHubCall[] {
  return h.stub.calls.filter((call) => call.method === 'GET' && /\/issues\/\d+$/.test(call.url.pathname));
}

async function problemSlug(response: Response): Promise<string | null> {
  const body: unknown = await response.json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

async function ownWrites(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare('SELECT * FROM own_writes ORDER BY issue_number').all();
  return results;
}

beforeEach(async () => {
  await resetProjects();
  await resetOwnerConnections();
  await env.DB.prepare('DELETE FROM own_writes').run();
  await env.DB.prepare('DELETE FROM own_write_claims').run();
  await seedProject('tc', REPO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approving a batch', () => {
  it('writes every item byte for byte as backlog answer approve, as the owner, in order (200)', async () => {
    const h = harness();
    const pair = await seedConnection(h.fake);

    const results = await resultsOf(await batch(h, { numbers: [2, 1], ownerSaid: SAID }));

    const expected = answerComment({
      command: 'approve',
      ownerSaid: SAID,
      section: 'question',
      via: 'console',
    });
    expect(expected).toBe(`/approve\n\n_Answered by the owner in the team console: «${SAID}»_\n`);
    expect(h.fake.comments.map(({ issue, author, body }) => ({ issue, author, body }))).toEqual([
      { issue: 2, author: OWNER.login, body: expected },
      { issue: 1, author: OWNER.login, body: expected },
    ]);
    expect(results).toEqual([
      {
        number: 2,
        ok: true,
        commentId: h.fake.comments[0]?.id,
        url: `https://github.com/${REPO}/issues/2#issuecomment-${h.fake.comments[0]?.id}`,
        replayed: false,
      },
      {
        number: 1,
        ok: true,
        commentId: h.fake.comments[1]?.id,
        url: `https://github.com/${REPO}/issues/1#issuecomment-${h.fake.comments[1]?.id}`,
        replayed: false,
      },
    ]);
    expect(posts(h).map((call) => call.headers.get('authorization'))).toEqual([
      `Bearer ${pair.accessToken}`,
      `Bearer ${pair.accessToken}`,
    ]);
    expect(await ownWrites()).toEqual([
      expect.objectContaining({ issue_number: 1, kind: 'answer', repo: REPO }),
      expect.objectContaining({ issue_number: 2, kind: 'answer', repo: REPO }),
    ]);
  });

  it('checks the owner and the repository once for the whole batch, not per item', async () => {
    const h = harness();
    await seedConnection(h.fake);
    await resultsOf(await batch(h, { numbers: [1, 2, 3], ownerSaid: SAID }));
    const repositoryReads = h.stub.calls.filter((call) => call.url.pathname === `/repos/${REPO}`);
    expect(repositoryReads).toHaveLength(1);
    expect(issueReads(h)).toHaveLength(3);
  });

  it(`answers ${BATCH_ANSWER_MAX} items within the subrequest budget of ${BATCH_GITHUB_BUDGET}`, async () => {
    const h = harness();
    await seedConnection(h.fake);
    const numbers = Array.from({ length: BATCH_ANSWER_MAX }, (_, index) => 100 + index);

    const results = await resultsOf(await batch(h, { numbers, ownerSaid: SAID }));

    expect(results.every((result) => result.ok)).toBe(true);
    const summary = parsedLogs(h.logs).find((line) => line['message'] === 'owner batch answered');
    expect(summary).toMatchObject({ items: BATCH_ANSWER_MAX, failed: 0 });
    // Token lookup + mint, the repository read, and an issue read and a comment per item.
    expect(summary?.['subrequests']).toBe(2 + 1 + 2 * BATCH_ANSWER_MAX);
    expect(Number(summary?.['subrequests'])).toBeLessThanOrEqual(BATCH_GITHUB_BUDGET);
  });
});

describe('the server re-checks every item; the client list is never trusted', () => {
  it.each([
    ['money', 10],
    ['release', 11],
    ['legal', 12],
    ['access', 13],
    ['design', 14],
    ['design', 15],
    ['release', 16],
    ['reject', 17],
    ['uncategorised', 18],
    ['untrusted', 19],
    ['no-recommendation', 20],
    ['money', 21],
  ] as const)(
    'refuses a %s item (#%i) with 422 batch-not-safe and writes the rest',
    async (reason, number) => {
      const h = harness();
      await seedConnection(h.fake);

      const results = await resultsOf(await batch(h, { numbers: [number, 1], ownerSaid: SAID }));

      expect(slugOf(results[0])).toBe('batch-not-safe');
      expect(results[0]?.problem).toMatchObject({ status: 422, reason });
      expect(results[1]).toMatchObject({ number: 1, ok: true });
      expect(h.fake.comments.map((comment) => comment.issue)).toEqual([1]);
    },
  );

  it.each([
    ['issue-closed', 30, 409],
    ['answer-not-allowed', 31, 422],
    ['answer-not-waiting', 32, 422],
    ['answer-not-waiting', 33, 422],
    ['github-not-found', 404, 404],
  ] as const)('answers %s for #%i in that item’s result', async (slug, number, status) => {
    const h = harness();
    await seedConnection(h.fake);

    const results = await resultsOf(await batch(h, { numbers: [number], ownerSaid: SAID }));

    expect(slugOf(results[0])).toBe(slug);
    expect(results[0]?.problem).toMatchObject({ status });
    expect(posts(h)).toEqual([]);
  });
});

describe('one item failing', () => {
  it('a 502 on one comment gives 200 with that item’s problem and the others written', async () => {
    const h = harness({ instantSleep: true });
    await seedConnection(h.fake);
    h.commentReplies.set(2, () => json(502, { message: 'bad gateway' }));

    const results = await resultsOf(await batch(h, { numbers: [1, 2, 3], ownerSaid: SAID }));

    expect(results.map((result) => [result.number, result.ok])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(slugOf(results[1])).toBe('github-unavailable');
    expect(h.fake.comments.map((comment) => comment.issue)).toEqual([1, 3]);
    // Never retried within the request.
    expect(posts(h).filter((call) => call.url.pathname.endsWith('/issues/2/comments'))).toHaveLength(1);
  });

  it('a retry of only the failed item after the window writes it once', async () => {
    const h = harness({ instantSleep: true });
    await seedConnection(h.fake);
    h.commentReplies.set(2, () => json(502, { message: 'bad gateway' }));
    await resultsOf(await batch(h, { numbers: [1, 2], ownerSaid: SAID }));

    // GitHub may have written it: inside the window a repeat is held off, never posted twice.
    h.commentReplies.clear();
    const held = await resultsOf(await batch(h, { numbers: [2], ownerSaid: SAID }));
    expect(slugOf(held[0])).toBe('answer-in-progress');

    h.clock += REPLAY_WINDOW_MS + 1_000;
    const retried = await resultsOf(await batch(h, { numbers: [2], ownerSaid: SAID }));
    expect(retried[0]).toMatchObject({ number: 2, ok: true, replayed: false });
    expect(h.fake.comments.map((comment) => comment.issue)).toEqual([1, 2]);
  });
});

describe('the same batch twice (decision 19)', () => {
  it('replays every item within 60 s from own_writes and posts nothing new', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const body = { numbers: [1, 2, 3], ownerSaid: SAID };
    const first = await resultsOf(await batch(h, body));

    h.clock += 59_000;
    const second = await resultsOf(await batch(h, body));

    expect(second).toEqual(first.map((result) => ({ ...result, replayed: true })));
    expect(posts(h)).toHaveLength(3);
  });
});

describe('the whole request is refused before any item', () => {
  it('403 github-owner-not-connected, no issue read and nothing written', async () => {
    const h = harness();
    const response = await batch(h, { numbers: [1, 2], ownerSaid: SAID });
    expect(response.status).toBe(403);
    expect(await problemSlug(response)).toBe('github-owner-not-connected');
    expect(issueReads(h)).toEqual([]);
    expect(posts(h)).toEqual([]);
  });

  it('409 github-owner-mismatch, no issue read and nothing written', async () => {
    const h = harness();
    await seedConnection(h.fake);
    h.repoOwner = { login: 'someone-else', id: OWNER.id };
    const response = await batch(h, { numbers: [1, 2], ownerSaid: SAID });
    expect(response.status).toBe(409);
    expect(await problemSlug(response)).toBe('github-owner-mismatch');
    expect(issueReads(h)).toEqual([]);
    expect(posts(h)).toEqual([]);
  });

  it.each([
    ['more than 15 numbers', { numbers: Array.from({ length: 16 }, (_, i) => i + 1), ownerSaid: SAID }],
    ['a repeated number', { numbers: [1, 2, 1], ownerSaid: SAID }],
    ['no numbers', { numbers: [], ownerSaid: SAID }],
    ['a number that is not an issue number', { numbers: [1, 0], ownerSaid: SAID }],
    ['a fractional number', { numbers: [1.5], ownerSaid: SAID }],
    ['a string number', { numbers: ['1'], ownerSaid: SAID }],
    ['blank words', { numbers: [1], ownerSaid: '  ' }],
    ['words over 2000 characters', { numbers: [1], ownerSaid: 'x'.repeat(2001) }],
    ['an unknown member', { numbers: [1], ownerSaid: SAID, command: 'reject' }],
    ['a non-object body', [1, 2]],
  ])('422 validation for %s, before any GitHub call', async (_, body) => {
    const h = harness();
    await seedConnection(h.fake);
    const response = await batch(h, body);
    expect(response.status).toBe(422);
    expect(await problemSlug(response)).toBe('validation');
    expect(h.stub.calls).toEqual([]);
  });

  it('404 project-not-found for an unknown slug', async () => {
    const h = harness();
    const response = await fetchApi('/api/v1/projects/nope/answers/batch', localEnv(), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ numbers: [1], ownerSaid: SAID }),
      github: h.github,
    });
    expect(response.status).toBe(404);
    expect(h.stub.calls).toEqual([]);
  });
});

describe('Access, CSRF and the service identity', () => {
  it('403 owner-only for the service identity on dev and stage, with zero GitHub calls', async () => {
    for (const environment of ['dev', 'stage']) {
      const h = harness();
      await seedConnection(h.fake, { environment });
      const jwks = stubJwksServer();
      const teamDomain = uniqueTeamDomain();
      const key = await createSigningKey();
      jwks.set(teamDomain, { keys: [key.publicJwk] });
      const token = await signAccessToken(key, teamDomain, {
        claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
      });

      const response = await batch(
        h,
        { numbers: [1], ownerSaid: SAID },
        {
          bindings: accessEnv(teamDomain, { ENVIRONMENT: environment }),
          headers: { ...WRITE_HEADERS, 'Cf-Access-Jwt-Assertion': token },
        },
      );

      expect(response.status).toBe(403);
      expect(await problemSlug(response)).toBe('owner-only');
      expect(h.stub.calls).toEqual([]);
      expect(h.fake.comments).toEqual([]);
    }
  });

  it('403 csrf on a cross-site write', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const response = await batch(
      h,
      { numbers: [1], ownerSaid: SAID },
      { headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' } },
    );
    expect(response.status).toBe(403);
    expect(await problemSlug(response)).toBe('csrf');
    expect(h.stub.calls).toEqual([]);
  });
});
