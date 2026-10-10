import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf, type IssueRequestDto, type RequestIssuesDto } from '@shared/contracts';
import { commandLines, handledMarker, requestComment } from '@shared/owner-grammar';
import type { FakeGitHubOAuth, FakeMilestoneSeed } from '@worker/github/testing';
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
} from '../testing/github-kit';
import { OWNER, fakeGitHub, resetOwnerConnections, seedConnection } from '../testing/owner-kit';
import { rereadPagesOf } from './owner-request';

// #219: owner requests to the PM, end to end through the Worker. The fake GitHub serves the issue, the sprints and
// the comments, and takes the owner's comment; every call is recorded, so "nothing else was written" is checked.

const REPO = 'geeera/team-console';
const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
const NOW = Date.parse('2026-10-06T09:00:00.000Z');
const SPRINTS: readonly FakeMilestoneSeed[] = [
  { number: 4, title: 'Sprint 04', dueOn: '2026-10-14T12:00:00Z' },
  { number: 5, title: 'Sprint 05', dueOn: '2026-10-28T12:00:00Z' },
];
const TEAM_BOT = 'team-console-team[bot]';

interface Harness {
  readonly fake: FakeGitHubOAuth;
  readonly github: ApiGitHub;
  readonly calls: GitHubCall[];
  /** The Worker's clock. */
  clock: number;
  /** How far GitHub's clock is from the Worker's (negative: GitHub lags behind). */
  githubOffsetMs: number;
  projectYml: string;
}

function toRequest(call: GitHubCall): Request {
  return new Request(call.url.href, {
    method: call.method,
    headers: call.headers,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function harness(milestones: readonly FakeMilestoneSeed[] = SPRINTS): Harness {
  const h = {
    clock: NOW,
    githubOffsetMs: 0,
    projectYml: 'name: TC\nowner:\n  language: ru\n',
  } as unknown as Harness;
  const fake = fakeGitHub({ tokenTag: 'TESTSENTINEL', now: () => h.clock + h.githubOffsetMs });
  fake.seedIssue({
    repo: REPO,
    number: 7,
    title: 'Board filters',
    author: OWNER.login,
    repoOwner: OWNER,
    milestone: 'Sprint 04',
  });
  fake.seedIssue({ repo: REPO, number: 8, title: 'Backlog idea', author: OWNER.login, repoOwner: OWNER });
  fake.seedIssue({
    repo: REPO,
    number: 9,
    title: 'Done',
    author: OWNER.login,
    repoOwner: OWNER,
    state: 'closed',
  });
  fake.seedIssue({
    repo: REPO,
    number: 10,
    title: 'A PR',
    author: OWNER.login,
    repoOwner: OWNER,
    isPullRequest: true,
  });
  fake.seedMilestones(REPO, milestones);
  const stub = stubGitHub(async (call) => {
    if (call.url.pathname === `/repos/${REPO}/contents/.product-team/project.yml`) {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: h.projectYml.length,
        content: base64(h.projectYml),
      });
    }
    if (call.url.pathname === `/repos/${REPO}/issues`) {
      // The open-issues list of the picker: the open ones the fake serves, a pull request among them.
      const issue = (number: number, title: string, isPull = false): Record<string, unknown> => ({
        number,
        title,
        body: '',
        state: 'open',
        labels: [],
        user: { login: OWNER.login, type: 'User' },
        author_association: 'OWNER',
        html_url: `https://github.com/${REPO}/issues/${number}`,
        ...(isPull ? { pull_request: {} } : {}),
      });
      return json(200, [
        issue(7, 'Board filters'),
        issue(8, 'Backlog idea'),
        issue(10, 'A PR', true),
        // #287: a title with a bidi override and a zero-width space, as an outsider could write it.
        issue(12, 'Board \u202esretlif\u202c for\u200b everyone'),
      ]);
    }
    return fake.handle(toRequest(call));
  });
  Object.assign(h, {
    fake,
    calls: stub.calls,
    github: new ApiGitHub({ fetch: stub.fetch, now: () => h.clock, sleep: async () => undefined }),
  });
  return h;
}

function ask(
  h: Harness,
  issue: number,
  body: unknown,
  bindings: Parameters<typeof fetchApi>[1] = localEnv(),
  headers: Record<string, string> = WRITE_HEADERS,
): Promise<Response> {
  return fetchApi(`/api/v1/projects/tc/issues/${issue}/request`, bindings, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    github: h.github,
  });
}

function read(
  h: Harness,
  issue: number,
  bindings: Parameters<typeof fetchApi>[1] = localEnv(),
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchApi(`/api/v1/projects/tc/issues/${issue}/request`, bindings, {
    method: 'GET',
    headers,
    github: h.github,
  });
}

/** The comment pages the re-read asked for on `issue`, in order. */
function commentPagesRead(h: Harness, issue: number): number[] {
  return h.calls
    .filter((c) => c.method === 'GET' && c.url.pathname === `/repos/${REPO}/issues/${issue}/comments`)
    .map((c) => Number(c.url.searchParams.get('page')));
}

/** A valid Access service-token JWT and the env that trusts it (`identity.kind === 'service'`). */
async function serviceIdentity(): Promise<{ bindings: Parameters<typeof fetchApi>[1]; token: string }> {
  const jwks = stubJwksServer();
  const teamDomain = uniqueTeamDomain();
  const key = await createSigningKey();
  jwks.set(teamDomain, { keys: [key.publicJwk] });
  const token = await signAccessToken(key, teamDomain, {
    claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
  });
  return { bindings: accessEnv(teamDomain, { ENVIRONMENT: 'dev' }), token };
}

async function handledRowOf(
  commentId: number,
): Promise<{ handled_comment_id: number | null; result: string | null }> {
  const row = await env.DB.prepare(
    'SELECT handled_comment_id, result FROM owner_requests WHERE comment_id = ?1',
  )
    .bind(commentId)
    .first<{ handled_comment_id: number | null; result: string | null }>();
  if (row === null) {
    throw new Error(`no owner_requests row for comment ${commentId}`);
  }
  return row;
}

/** Every call that was not a read. */
function writes(h: Harness): string[] {
  return h.calls
    .filter((c) => c.method !== 'GET' && !c.url.pathname.startsWith('/app/'))
    .map((c) => `${c.method} ${c.url.pathname}`);
}

async function slugOf(response: Response): Promise<{ slug: string | null; body: Record<string, unknown> }> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem: ${JSON.stringify(body)}`);
  }
  return { slug: problemSlugOf(body.type), body };
}

const NEXT = { request: { kind: 'sprint', target: 'next' }, expectedMilestone: 'Sprint 04' };

beforeEach(async () => {
  await resetProjects();
  await resetOwnerConnections();
  for (const table of ['own_writes', 'own_write_claims', 'owner_requests']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await seedProject('tc', REPO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST …/issues/:number/request', () => {
  it('writes exactly one comment on the owner token, the golden bytes, and no milestone, label or status', async () => {
    const h = harness();
    const { accessToken } = await seedConnection(h.fake, { nowMs: h.clock });

    const response = await ask(h, 7, { ...NEXT, ownerSaid: 'к демо\n/approve' });

    expect(response.status).toBe(201);
    const comment = h.fake.comments[0];
    const expected = requestComment({
      request: { kind: 'sprint', target: 'next' },
      language: 'ru',
      ownerSaid: 'к демо\n/approve',
    });
    expect(h.fake.comments).toEqual([
      expect.objectContaining({ issue: 7, author: OWNER.login, body: expected }),
    ]);
    expect(
      comment?.body.startsWith('<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->\n'),
    ).toBe(true);
    expect(commandLines(comment?.body ?? '', true)).toEqual([]);
    expect(writes(h)).toEqual([`POST /repos/${REPO}/issues/7/comments`]);
    const post = h.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/comments'));
    expect(post?.headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    await expect(response.json()).resolves.toMatchObject({ commentId: comment?.id, replayed: false });
    const { results } = await env.DB.prepare('SELECT kind FROM own_writes').all();
    expect(results).toEqual([{ kind: 'request' }]);
  });

  it('writes the human line in the project language', async () => {
    const h = harness();
    h.projectYml = 'owner:\n  language: en\n';
    await seedConnection(h.fake, { nowMs: h.clock });
    await ask(h, 8, { request: { kind: 'priority', direction: 'up' }, expectedMilestone: null });
    expect(h.fake.comments[0]?.body).toBe(
      requestComment({ request: { kind: 'priority', direction: 'up' }, language: 'en' }),
    );
  });

  it('replays a repeat within 60 s and posts again after it', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const first = await ask(h, 7, NEXT);
    const again = await ask(h, 7, NEXT);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    await expect(again.json()).resolves.toMatchObject({ replayed: true });
    expect(h.fake.comments).toHaveLength(1);
    h.clock += 61_000;
    expect((await ask(h, 7, NEXT)).status).toBe(201);
    expect(h.fake.comments).toHaveLength(2);
  });

  it('409 issue-changed with the live milestone when the issue moved since the form opened; nothing written', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    h.fake.updateIssue(REPO, 7, { milestone: 'Sprint 05' });
    const response = await ask(h, 7, NEXT);
    expect(response.status).toBe(409);
    const problem = await slugOf(response);
    expect(problem.slug).toBe('issue-changed');
    expect(problem.body['milestone']).toBe('Sprint 05');
    expect(writes(h)).toEqual([]);
  });

  it.each([
    ['issue-closed', 409, 9, { request: { kind: 'priority', direction: 'up' }, expectedMilestone: null }],
    [
      'request-not-issue',
      422,
      10,
      { request: { kind: 'priority', direction: 'up' }, expectedMilestone: null },
    ],
    [
      'validation',
      422,
      7,
      { request: { kind: 'sprint', target: 'next', direction: 'up' }, expectedMilestone: null },
    ],
    ['validation', 422, 7, { request: { kind: 'tier', target: 'heavy' }, expectedMilestone: null }],
  ] as const)('%s (%i) on #%i writes nothing', async (slug, status, issue, body) => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await ask(h, issue, body);
    expect(response.status).toBe(status);
    expect((await slugOf(response)).slug).toBe(slug);
    expect(writes(h)).toEqual([]);
  });

  it('422 sprint-next-missing when no next sprint exists', async () => {
    const h = harness([SPRINTS[0] as FakeMilestoneSeed]);
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await ask(h, 7, NEXT);
    expect(response.status).toBe(422);
    expect((await slugOf(response)).slug).toBe('sprint-next-missing');
    expect(writes(h)).toEqual([]);
  });

  it('409 sprint-none for "current" when there is no current sprint; nothing written (#272)', async () => {
    const h = harness([]);
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await ask(h, 8, {
      request: { kind: 'sprint', target: 'current' },
      expectedMilestone: null,
    });
    expect(response.status).toBe(409);
    expect((await slugOf(response)).slug).toBe('sprint-none');
    expect(h.fake.comments).toEqual([]);
    expect(writes(h)).toEqual([]);
  });

  it("stores GitHub's created_at as requestedAt, so a Worker clock running ahead cannot refuse the PM's answer (#269)", async () => {
    const h = harness();
    // GitHub's clock is 90 s behind the Worker's.
    h.githubOffsetMs = -90_000;
    const githubCreatedAt = new Date(NOW - 90_000).toISOString();
    await seedConnection(h.fake, { nowMs: h.clock });

    const first = (await (await ask(h, 7, NEXT)).json()) as { commentId: number; requestedAt: string };
    expect(first.requestedAt).toBe(githubCreatedAt);
    const { results } = await env.DB.prepare('SELECT requested_at FROM owner_requests').all();
    expect(results).toEqual([{ requested_at: githubCreatedAt }]);
    const replay = (await (await ask(h, 7, NEXT)).json()) as { replayed: boolean; requestedAt: string };
    expect(replay).toEqual(expect.objectContaining({ replayed: true, requestedAt: githubCreatedAt }));

    // The PM answers 30 s after the comment by GitHub's clock — still 60 s before the Worker's time of the post.
    h.fake.addComment(REPO, 7, {
      body: `${handledMarker({ commentId: first.commentId, result: 'applied' })}\n**PM note**: done.`,
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: NOW - 60_000,
    });
    h.clock += 120_000;
    const body = (await (await read(h, 7)).json()) as IssueRequestDto;
    expect(body.request).toMatchObject({ state: 'applied', requestedAt: githubCreatedAt });
  });

  it('403 github-owner-not-connected before GitHub is asked', async () => {
    const h = harness();
    const response = await ask(h, 7, NEXT);
    expect(response.status).toBe(403);
    expect((await slugOf(response)).slug).toBe('github-owner-not-connected');
    expect(h.calls).toEqual([]);
  });

  it('refuses the service identity with 403 owner-only and zero GitHub calls', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock, environment: 'dev' });
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
    });
    const response = await ask(h, 7, NEXT, accessEnv(teamDomain, { ENVIRONMENT: 'dev' }), {
      ...WRITE_HEADERS,
      'Cf-Access-Jwt-Assertion': token,
    });
    expect(response.status).toBe(403);
    expect((await slugOf(response)).slug).toBe('owner-only');
    expect(h.calls).toEqual([]);
  });
});

describe('GET …/issues/:number/request', () => {
  it('shows the live issue, the sprints and the pending request; a new request replaces the older one', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    await ask(h, 7, NEXT);
    h.clock += 61_000;
    await ask(h, 7, { request: { kind: 'sprint', target: 'backlog' }, expectedMilestone: 'Sprint 04' });

    const response = await read(h, 7);
    expect(response.status).toBe(200);
    const body = (await response.json()) as IssueRequestDto;
    expect(body).toMatchObject({
      number: 7,
      title: 'Board filters',
      state: 'open',
      milestone: 'Sprint 04',
      current: { title: 'Sprint 04', due: '2026-10-14' },
      next: { title: 'Sprint 05', due: '2026-10-28' },
      freezeNow: false,
      request: { kind: 'sprint', target: 'backlog', state: 'pending', handledAt: null },
    });
  });

  it.each([
    ['the team app, unedited, after the request', TEAM_BOT, 'Bot', 0, 0, 'applied'],
    ['a collaborator', 'collaborator', 'User', 0, 0, 'pending'],
    ['the owner', OWNER.login, 'User', 0, 0, 'pending'],
    ['an edited marker', TEAM_BOT, 'Bot', 0, 5_000, 'pending'],
    ['a marker from before the request', TEAM_BOT, 'Bot', -120_000, 0, 'pending'],
  ] as const)(
    'the re-read marks the request handled only for %s',
    async (_, author, type, offset, edit, state) => {
      const h = harness();
      await seedConnection(h.fake, { nowMs: h.clock });
      const posted = (await (await ask(h, 7, NEXT)).json()) as { commentId: number };
      const createdAt = h.clock + 60_000 + offset;
      h.fake.addComment(REPO, 7, {
        body: `${handledMarker({ commentId: posted.commentId, result: 'applied' })}\n**PM note**: done.`,
        author,
        authorType: type,
        createdAt,
        updatedAt: createdAt + edit,
      });
      h.clock += 120_000;
      const body = (await (await read(h, 7)).json()) as IssueRequestDto;
      expect(body.request?.state).toBe(state);
    },
  );

  it('a marker naming a request on another issue, or quoted in prose, changes nothing', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const on7 = (await (await ask(h, 7, NEXT)).json()) as { commentId: number };
    await ask(h, 8, { request: { kind: 'priority', direction: 'down' }, expectedMilestone: null });
    const at = h.clock + 60_000;
    h.fake.addComment(REPO, 8, {
      body: handledMarker({ commentId: on7.commentId, result: 'declined' }),
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: at,
    });
    h.fake.addComment(REPO, 7, {
      body: `As noted: ${handledMarker({ commentId: on7.commentId, result: 'declined' })}`,
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: at,
    });
    h.clock += 120_000;
    expect(((await (await read(h, 7)).json()) as IssueRequestDto).request?.state).toBe('pending');
    expect(((await (await read(h, 8)).json()) as IssueRequestDto).request?.state).toBe('pending');
  });

  it('after a missed webhook, finds the marker on the page before a short last page (#270)', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const posted = (await (await ask(h, 7, NEXT)).json()) as { commentId: number };
    const at = h.clock + 60_000;
    h.fake.addComment(REPO, 7, {
      body: `${handledMarker({ commentId: posted.commentId, result: 'applied' })}\n**PM note**: done.`,
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: at,
    });
    // 99 later comments: the thread has 101, the last page holds one and the marker sits on page 1.
    for (let i = 0; i < 99; i += 1) {
      h.fake.addComment(REPO, 7, {
        body: `discussion ${i}`,
        author: 'collaborator',
        createdAt: at + 1_000 + i,
      });
    }
    h.clock += 120_000;
    const body = (await (await read(h, 7)).json()) as IssueRequestDto;
    expect(body.request?.state).toBe('applied');
    expect(commentPagesRead(h, 7).sort()).toEqual([1, 2]);
  });

  it('reads one page while it holds the newest 100 comments, two otherwise', () => {
    expect(rereadPagesOf(0)).toEqual([1]);
    expect(rereadPagesOf(1)).toEqual([1]);
    expect(rereadPagesOf(100)).toEqual([1]);
    expect(rereadPagesOf(101)).toEqual([1, 2]);
    expect(rereadPagesOf(200)).toEqual([2]);
    expect(rereadPagesOf(250)).toEqual([2, 3]);
  });

  it("the GET changes a row only on a trusted bot's strict marker, also for the service identity, and never writes to GitHub (#270)", async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const posted = (await (await ask(h, 7, NEXT)).json()) as { commentId: number };
    const at = h.clock + 60_000;
    const marker = handledMarker({ commentId: posted.commentId, result: 'applied' });
    h.fake.addComment(REPO, 7, { body: marker, author: OWNER.login, authorType: 'User', createdAt: at });
    h.fake.addComment(REPO, 7, { body: marker, author: 'collaborator', authorType: 'User', createdAt: at });
    h.fake.addComment(REPO, 7, {
      body: `Quoting: ${marker}`,
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: at,
    });
    h.fake.addComment(REPO, 7, {
      body: marker,
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: at,
      updatedAt: at + 5_000,
    });
    h.clock += 120_000;
    const callsBefore = h.calls.length;
    const service = await serviceIdentity();
    const serviceHeaders = { 'Cf-Access-Jwt-Assertion': service.token };

    const untouched = await read(h, 7, service.bindings, serviceHeaders);
    expect(untouched.status).toBe(200);
    expect(((await untouched.json()) as IssueRequestDto).request?.state).toBe('pending');
    await expect(handledRowOf(posted.commentId)).resolves.toEqual({ handled_comment_id: null, result: null });

    const handledId = h.fake.addComment(REPO, 7, {
      body: `${marker}\n**PM note**: done.`,
      author: TEAM_BOT,
      authorType: 'Bot',
      createdAt: at + 10_000,
    });
    const handled = await read(h, 7, service.bindings, serviceHeaders);
    expect(((await handled.json()) as IssueRequestDto).request?.state).toBe('applied');
    await expect(handledRowOf(posted.commentId)).resolves.toEqual({
      handled_comment_id: handledId,
      result: 'applied',
    });
    expect(h.calls.slice(callsBefore).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('lists the request in the issue picker, without pull requests', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    await ask(h, 8, { request: { kind: 'priority', direction: 'up' }, expectedMilestone: null });
    const picker = await fetchApi('/api/v1/projects/tc/requests', localEnv(), {
      method: 'GET',
      github: h.github,
    });
    expect(picker.status).toBe(200);
    const items = ((await picker.json()) as { items: { number: number; request: unknown }[] }).items;
    expect(items.find((item) => item.number === 8)?.request).toMatchObject({
      kind: 'priority',
      state: 'pending',
    });
    expect(items.some((item) => item.number === 10)).toBe(false);
  });

  it('strips bidi and zero-width characters from the issue title, in the form and in the picker, never from the milestone (#287)', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    h.fake.seedIssue({
      repo: REPO,
      number: 12,
      title: 'Board \u202esretlif\u202c for\u200b everyone',
      author: 'outsider',
      repoOwner: OWNER,
      milestone: 'Sprint 04',
    });

    const body = (await (await read(h, 12)).json()) as IssueRequestDto;
    expect(body.title).toBe('Board sretlif for everyone');
    expect(body.milestone).toBe('Sprint 04');

    const picker = await fetchApi('/api/v1/projects/tc/requests', localEnv(), { method: 'GET', github: h.github });
    const items = ((await picker.json()) as RequestIssuesDto).items;
    expect(items.find((item) => item.number === 12)?.title).toBe('Board sretlif for everyone');
    for (const item of items) {
      expect(item.title).not.toMatch(/[\u200b\u202c\u202e]/u);
    }
  });
});
