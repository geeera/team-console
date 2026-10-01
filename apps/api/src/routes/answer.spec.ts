import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { answerComment } from '@shared/owner-grammar';
import type { FakeGitHubOAuth } from '@worker/github/testing';
import { ApiGitHub } from '../github';
import {
  OWNER as OWNER_EMAIL,
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import {
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
  type StubGitHub,
} from '../testing/github-kit';
import { OWNER, fakeGitHub, parsedLogs, resetOwnerConnections, seedConnection } from '../testing/owner-kit';
import { REPLAY_WINDOW_MS } from './answer';

// #10: POST /api/v1/projects/:slug/issues/:number/answer, end to end through the Worker. The fake GitHub holds the
// owner's tokens (tagged TESTSENTINEL) and takes the comments; the stub answers the installation-token reads.

const REPO = 'geeera/team-console';
const PATH = (issue: number | string): string => `/api/v1/projects/tc/issues/${issue}/answer`;
const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };

interface Issue {
  readonly state: string;
  readonly labels: readonly string[];
}

const ISSUES: Record<string, Issue> = {
  '7': { state: 'open', labels: ['kind:question', 'owner:scope'] },
  '8': { state: 'open', labels: ['team:demo', 'kind:chore'] },
  '9': { state: 'open', labels: ['needs:owner', 'kind:chore'] },
  '10': { state: 'closed', labels: ['kind:question'] },
  '11': { state: 'open', labels: ['kind:feature'] },
};

interface Harness {
  readonly fake: FakeGitHubOAuth;
  readonly stub: StubGitHub;
  readonly github: ApiGitHub;
  readonly logs: string[];
  readonly texts: string[];
  clock: number;
  repoOwner: { login: string; id: number };
  /** Replaces the fake's answer to the comment POST (5xx, repeated 401). */
  commentReply: ((call: GitHubCall) => Response) | undefined;
}

function toRequest(call: GitHubCall): Request {
  return new Request(call.url.href, {
    method: call.method,
    headers: call.headers,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
}

function harness(options: { instantSleep?: boolean } = {}): Harness {
  const fake = fakeGitHub({ tokenTag: 'TESTSENTINEL' });
  const h: Harness = {
    fake,
    logs: [],
    texts: [],
    clock: Date.now(),
    repoOwner: { login: OWNER.login, id: OWNER.id },
    commentReply: undefined,
    stub: stubGitHub(async (call) => {
      const path = call.url.pathname;
      if (call.method === 'POST' && path.endsWith('/comments')) {
        return h.commentReply?.(call) ?? fake.handle(toRequest(call));
      }
      if (call.url.origin === 'https://github.com' || path === '/user') {
        return fake.handle(toRequest(call));
      }
      const issue = /^\/repos\/geeera\/team-console\/issues\/(\d+)$/.exec(path);
      if (call.method === 'GET' && issue !== null) {
        const found = ISSUES[issue[1] ?? ''];
        return found === undefined
          ? json(404, { message: 'Not Found' })
          : json(200, {
              number: Number(issue[1]),
              state: found.state,
              labels: found.labels.map((name) => ({ name })),
            });
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

async function answer(
  h: Harness,
  issue: number | string,
  body: unknown,
  options: { bindings?: ReturnType<typeof localEnv>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const response = await fetchApi(PATH(issue), options.bindings ?? localEnv(), {
    method: 'POST',
    headers: options.headers ?? WRITE_HEADERS,
    body: JSON.stringify(body),
    github: h.github,
    logSink: (line) => h.logs.push(line),
  });
  h.texts.push(await response.clone().text(), JSON.stringify([...response.headers.entries()]));
  return response;
}

function posts(h: Harness): GitHubCall[] {
  return h.stub.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/comments'));
}

async function problemOf(
  response: Response,
): Promise<{ slug: string | null; body: Record<string, unknown> }> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem: ${JSON.stringify(body)}`);
  }
  return { slug: problemSlugOf(body.type), body };
}

async function ownWrites(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare('SELECT * FROM own_writes ORDER BY created_at').all();
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

describe('writing an answer', () => {
  it('posts the console grammar as the owner with the owner token and records the write (201)', async () => {
    const h = harness();
    const pair = await seedConnection(h.fake);

    const response = await answer(h, 7, { command: 'approve', text: 'ok\n/go', ownerSaid: 'да, так' });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    const comment = h.fake.comments[0];
    expect(body).toEqual({
      commentId: comment?.id,
      url: `https://github.com/${REPO}/issues/7#issuecomment-${comment?.id}`,
      section: 'question',
      command: 'approve',
      replayed: false,
    });
    expect(h.fake.comments).toEqual([
      {
        id: comment?.id,
        repo: REPO,
        issue: 7,
        author: OWNER.login,
        body: answerComment({
          command: 'approve',
          text: 'ok\n/go',
          ownerSaid: 'да, так',
          section: 'question',
          via: 'console',
        }),
      },
    ]);
    expect(comment?.body).toBe('/approve ok /go\n\n_Answered by the owner in the team console: «да, так»_\n');
    expect(await ownWrites()).toEqual([
      expect.objectContaining({ comment_id: comment?.id, repo: REPO, issue_number: 7, kind: 'answer' }),
    ]);
    expect(posts(h).map((call) => call.headers.get('authorization'))).toEqual([`Bearer ${pair.accessToken}`]);
  });

  it('never uses an installation token for the write: installation tokens only read', async () => {
    const h = harness();
    await seedConnection(h.fake);
    await answer(h, 8, { command: 'go', ownerSaid: 'поехали' });

    const bearerOf = (call: GitHubCall): string => call.headers.get('authorization') ?? '';
    expect(posts(h)).toHaveLength(1);
    expect(posts(h).every((call) => bearerOf(call).startsWith('Bearer ghu_'))).toBe(true);
    const installationUses = h.stub
      .reads()
      .filter((call) => bearerOf(call).startsWith(`Bearer ${TOKEN_SENTINEL}`));
    expect(installationUses.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `GET /repos/${REPO}/issues/8`,
      `GET /repos/${REPO}`,
    ]);
  });

  it('writes done with the marker on an action item', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const response = await answer(h, 9, { command: 'done', ownerSaid: 'создал' });
    expect(response.status).toBe(201);
    expect(h.fake.comments[0]?.body).toBe(
      '<!-- pt-owner-done -->\n**The owner reports this done.** \n\n_Answered by the owner in the team console: «создал»_\n',
    );
  });
});

describe('nothing is written on a 4xx', () => {
  it.each([
    ['not-waiting', 11, { command: 'approve', ownerSaid: 'да' }, null, []],
    ['not-allowed', 7, { command: 'done', ownerSaid: 'да' }, 'question', ['approve', 'reject']],
    ['not-allowed', 9, { command: 'approve', ownerSaid: 'да' }, 'owner', ['done']],
    [
      'needs-reason',
      8,
      { command: 'no-go', text: ' \n ', ownerSaid: 'нет' },
      'release',
      ['go', 'no-go', 'override'],
    ],
    ['needs-words', 7, { command: 'approve', ownerSaid: ' ' }, 'question', ['approve', 'reject']],
  ] as const)(
    '422 answer-%s on issue #%i with the section and the allowed commands',
    async (code, issue, body, section, allowed) => {
      const h = harness();
      await seedConnection(h.fake);
      const response = await answer(h, issue, body);
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.slug).toBe(`answer-${code}`);
      expect(problem.body).toMatchObject({ section, allowed });
      expect(posts(h)).toEqual([]);
      expect(await ownWrites()).toEqual([]);
    },
  );

  it('409 issue-closed on a closed issue', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const response = await answer(h, 10, { command: 'approve', ownerSaid: 'да' });
    expect(response.status).toBe(409);
    expect((await problemOf(response)).slug).toBe('issue-closed');
    expect(posts(h)).toEqual([]);
  });

  it.each([
    ['an unknown member', { command: 'approve', ownerSaid: 'да', section: 'question' }],
    ['an unknown command', { command: 'resume', ownerSaid: 'да' }],
    ['a missing ownerSaid', { command: 'approve' }],
    ['a text over 2000 characters', { command: 'approve', text: 'x'.repeat(2001), ownerSaid: 'да' }],
    ['words over 2000 characters', { command: 'approve', ownerSaid: 'x'.repeat(2001) }],
    ['a non-object body', ['approve']],
  ])('422 validation for %s, before any GitHub call', async (_, body) => {
    const h = harness();
    const response = await answer(h, 7, body);
    expect(response.status).toBe(422);
    expect((await problemOf(response)).slug).toBe('validation');
    expect(h.stub.calls).toEqual([]);
  });

  it.each(['0', '07', 'abc', '99999999999'])('422 validation for the issue number %s', async (issue) => {
    const h = harness();
    const response = await answer(h, issue, { command: 'approve', ownerSaid: 'да' });
    expect(response.status).toBe(422);
    expect(h.stub.calls).toEqual([]);
  });

  it('404 project-not-found for an unknown slug', async () => {
    const h = harness();
    const response = await fetchApi('/api/v1/projects/nope/issues/7/answer', localEnv(), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ command: 'approve', ownerSaid: 'да' }),
      github: h.github,
    });
    expect(response.status).toBe(404);
    expect(h.stub.calls).toEqual([]);
  });

  it.each([
    ['another login', { login: 'someone-else', id: OWNER.id }],
    ['the same login with another id (a re-registered login)', { login: 'GEEERA', id: 999 }],
  ])('409 github-owner-mismatch when the repository belongs to %s', async (_, owner) => {
    const h = harness();
    await seedConnection(h.fake);
    h.repoOwner = owner;
    const response = await answer(h, 7, { command: 'approve', ownerSaid: 'да' });
    expect(response.status).toBe(409);
    expect((await problemOf(response)).slug).toBe('github-owner-mismatch');
    expect(posts(h)).toEqual([]);
  });

  it('passes the owner check case-insensitively on the login', async () => {
    const h = harness();
    await seedConnection(h.fake);
    h.repoOwner = { login: 'GeEeRa', id: OWNER.id };
    expect((await answer(h, 7, { command: 'approve', ownerSaid: 'да' })).status).toBe(201);
  });

  it('403 github-owner-not-connected with connectUrl when no owner is connected', async () => {
    const h = harness();
    const response = await answer(h, 7, { command: 'approve', ownerSaid: 'да' });
    expect(response.status).toBe(403);
    const problem = await problemOf(response);
    expect(problem.slug).toBe('github-owner-not-connected');
    expect(problem.body['connectUrl']).toBe('/api/v1/github/connect');
    expect(problem.body['instance']).not.toBe('/api/v1/github/connect');
    expect(posts(h)).toEqual([]);
    // The claim was released: once connected, the same answer goes through.
    await seedConnection(h.fake);
    expect((await answer(h, 7, { command: 'approve', ownerSaid: 'да' })).status).toBe(201);
  });
});

describe('a refused owner token, a timeout, a 5xx', () => {
  it('refreshes once through #59 on a 401 and writes with the new token', async () => {
    const h = harness();
    const pair = await seedConnection(h.fake);
    h.fake.fail('comment-token-rejected');

    const response = await answer(h, 7, { command: 'approve', ownerSaid: 'да' });

    expect(response.status).toBe(201);
    const [first, second] = posts(h).map((call) => call.headers.get('authorization'));
    expect(first).toBe(`Bearer ${pair.accessToken}`);
    expect(second).not.toBe(first);
    expect(h.fake.refreshCalls()).toBe(1);
    expect(h.fake.comments).toHaveLength(1);
  });

  it('answers 403 github-owner-not-connected when the refreshed token is refused as well', async () => {
    const h = harness();
    await seedConnection(h.fake);
    h.commentReply = () => json(401, { message: 'Bad credentials' });

    const response = await answer(h, 7, { command: 'approve', ownerSaid: 'да' });

    expect(response.status).toBe(403);
    expect((await problemOf(response)).slug).toBe('github-owner-not-connected');
    expect(posts(h)).toHaveLength(2);
    expect(h.fake.refreshCalls()).toBe(1);
  });

  it.each([
    ['a 5xx', () => json(502, { message: 'bad gateway' })],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
  ])('never retries after %s, and holds a repeat off for the replay window', async (_, reply) => {
    const h = harness({ instantSleep: true });
    await seedConnection(h.fake);
    h.commentReply = reply;

    const response = await answer(h, 7, { command: 'approve', ownerSaid: 'да' });
    expect(response.status).toBe(502);
    expect(posts(h)).toHaveLength(1);

    // GitHub may have written it: a repeat inside the window is not sent again.
    h.commentReply = undefined;
    const repeat = await answer(h, 7, { command: 'approve', ownerSaid: 'да' });
    expect(repeat.status).toBe(409);
    expect((await problemOf(repeat)).slug).toBe('answer-in-progress');
    expect(repeat.headers.get('retry-after')).toBe('2');
    expect(posts(h)).toHaveLength(1);

    h.clock += REPLAY_WINDOW_MS + 1_000;
    expect((await answer(h, 7, { command: 'approve', ownerSaid: 'да' })).status).toBe(201);
    expect(posts(h)).toHaveLength(2);
  });
});

describe('the same answer twice (decision 19)', () => {
  it('writes once within 60 s, replays from own_writes, writes again 61 s later', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const body = { command: 'reject', text: 'рано', ownerSaid: 'нет, рано' };

    const first = await answer(h, 7, body);
    expect(first.status).toBe(201);
    const created = (await first.json()) as Record<string, unknown>;

    h.clock += 59_000;
    const second = await answer(h, 7, body);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual({ ...created, replayed: true });
    expect(posts(h)).toHaveLength(1);

    h.clock += 2_000;
    const third = await answer(h, 7, body);
    expect(third.status).toBe(201);
    expect(third.headers.get('idempotent-replayed')).toBeNull();
    expect(posts(h)).toHaveLength(2);
    expect(await ownWrites()).toHaveLength(2);
  });

  it('writes a different text, command or issue as a new comment', async () => {
    const h = harness();
    await seedConnection(h.fake);
    await answer(h, 7, { command: 'reject', text: 'рано', ownerSaid: 'нет' });
    await answer(h, 7, { command: 'reject', text: 'поздно', ownerSaid: 'нет' });
    await answer(h, 7, { command: 'approve', ownerSaid: 'нет' });
    await answer(h, 8, { command: 'no-go', text: 'рано', ownerSaid: 'нет' });
    expect(posts(h)).toHaveLength(4);
  });

  it('a double tap that arrives together posts once', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const body = { command: 'approve', ownerSaid: 'да' };

    const responses = await Promise.all([answer(h, 7, body), answer(h, 7, body)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(posts(h)).toHaveLength(1);
  });
});

describe('Access, CSRF and the service identity', () => {
  async function signed(environment: string, claims: Record<string, unknown>) {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    return {
      bindings: accessEnv(teamDomain, { ENVIRONMENT: environment }),
      token: await signAccessToken(key, teamDomain, { claims }),
    };
  }

  it('401 access-missing without Cf-Access-Jwt-Assertion', async () => {
    const h = harness();
    stubJwksServer();
    const response = await answer(
      h,
      7,
      { command: 'approve', ownerSaid: 'да' },
      {
        bindings: accessEnv(uniqueTeamDomain()),
      },
    );
    expect(response.status).toBe(401);
    expect((await problemOf(response)).slug).toBe('access-missing');
    expect(h.stub.calls).toEqual([]);
  });

  it('403 csrf on a cross-site write', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const response = await answer(
      h,
      7,
      { command: 'approve', ownerSaid: 'да' },
      {
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      },
    );
    expect(response.status).toBe(403);
    expect((await problemOf(response)).slug).toBe('csrf');
    expect(h.stub.calls).toEqual([]);
  });

  it.each(['dev', 'stage'])(
    '403 owner-only for the Access service identity on %s (team decision until #62), nothing read or written',
    async (environment) => {
      const h = harness();
      await seedConnection(h.fake);
      const { bindings, token } = await signed(environment, {
        email: undefined,
        common_name: SERVICE_TOKEN_ID,
      });
      const response = await answer(
        h,
        7,
        { command: 'approve', ownerSaid: 'да' },
        {
          bindings,
          headers: { ...WRITE_HEADERS, 'Cf-Access-Jwt-Assertion': token },
        },
      );
      expect(response.status).toBe(403);
      expect((await problemOf(response)).slug).toBe('owner-only');
      expect(h.stub.calls).toEqual([]);
    },
  );

  it('refuses the service identity in production already at Access (never reaches the route)', async () => {
    const h = harness();
    const { bindings, token } = await signed('production', {
      email: undefined,
      common_name: SERVICE_TOKEN_ID,
    });
    const response = await answer(
      h,
      7,
      { command: 'approve', ownerSaid: 'да' },
      {
        bindings,
        headers: { ...WRITE_HEADERS, 'Cf-Access-Jwt-Assertion': token },
      },
    );
    expect([401, 403]).toContain(response.status);
    expect(h.stub.calls).toEqual([]);
  });

  it('the owner (a user identity) answers', async () => {
    const h = harness();
    await seedConnection(h.fake);
    const { bindings, token } = await signed('local', { email: OWNER_EMAIL });
    const response = await answer(
      h,
      7,
      { command: 'approve', ownerSaid: 'да' },
      {
        bindings,
        headers: { ...WRITE_HEADERS, 'Cf-Access-Jwt-Assertion': token },
      },
    );
    expect(response.status).toBe(201);
  });
});

describe('logs and sentinels', () => {
  const FORBIDDEN = ['TESTSENTINEL', 'ghu_', 'ghr_', 'ghs_'];
  const TEXT = 'секретный-текст-причины';
  const WORDS = 'слова-владельца-целиком';

  it('logs request id, slug, issue, command and identity kind only — never text, words, body or a token', async () => {
    const h = harness({ instantSleep: true });
    await seedConnection(h.fake);
    await answer(h, 7, { command: 'reject', text: TEXT, ownerSaid: WORDS });
    await answer(h, 7, { command: 'reject', text: TEXT, ownerSaid: WORDS });
    await answer(h, 9, { command: 'approve', text: TEXT, ownerSaid: WORDS });
    h.fake.fail('comment-token-rejected');
    await answer(h, 8, { command: 'go', text: TEXT, ownerSaid: WORDS });
    h.commentReply = () => json(401, { message: 'Bad credentials' });
    await answer(h, 8, { command: 'override', text: TEXT, ownerSaid: WORDS });
    h.commentReply = () => json(502, { message: 'x' });
    await answer(h, 8, { command: 'no-go', text: TEXT, ownerSaid: WORDS });
    await answer(h, 8, { command: 'no-go', text: TEXT, ownerSaid: WORDS });

    const logs = h.logs.join('\n');
    for (const forbidden of [...FORBIDDEN, TEXT, WORDS, 'Answered by the owner']) {
      expect(logs.includes(forbidden), `logs contain ${forbidden}`).toBe(false);
    }
    const bodiesAndHeaders = h.texts.join('\n');
    for (const forbidden of FORBIDDEN) {
      expect(bodiesAndHeaders.includes(forbidden), `responses contain ${forbidden}`).toBe(false);
    }
    const written = parsedLogs(h.logs).find((line) => line['message'] === 'owner answer written');
    expect(written).toBeDefined();
    expect(Object.keys(written ?? {}).sort()).toEqual(
      ['command', 'identity', 'issue', 'level', 'message', 'requestId', 'service', 'slug', 'ts'].sort(),
    );
    expect(written).toMatchObject({ slug: 'tc', issue: 7, command: 'reject', identity: 'local' });
    expect(parsedLogs(h.logs)).toContainEqual(expect.objectContaining({ message: 'owner answer replayed' }));
  });
});
