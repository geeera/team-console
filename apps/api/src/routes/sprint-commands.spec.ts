import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf, type TeamStatusDto } from '@shared/contracts';
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

// #218: move the demo and start the next sprint, end to end through the Worker. The fake GitHub serves the
// milestones to the installation token and takes the owner's milestone writes; every credential is a sentinel.

const REPO = 'geeera/team-console';
const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
const PROJECT_YML = 'name: Team Console\nsprint:\n  length_days: 14\n  freeze_days: 2\n';
// 12:00 in Kyiv on Monday 5 October 2026.
const NOW = Date.parse('2026-10-05T09:00:00.000Z');

const SPRINTS: readonly FakeMilestoneSeed[] = [
  { number: 3, title: 'Sprint 03', state: 'closed', dueOn: '2026-09-30T12:00:00Z' },
  { number: 4, title: 'Sprint 04', dueOn: '2026-10-14T12:00:00Z' },
];

interface Harness {
  readonly fake: FakeGitHubOAuth;
  readonly github: ApiGitHub;
  readonly calls: GitHubCall[];
  /** Runs before the fake answers a call (a PM writing meanwhile); a `Response` it returns answers instead. */
  before: ((call: GitHubCall) => Response | void) | null;
  clock: number;
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

function harness(milestones: readonly FakeMilestoneSeed[] = SPRINTS, projectYml = PROJECT_YML): Harness {
  const h = { before: null, clock: NOW } as unknown as Harness;
  const fake = fakeGitHub({ tokenTag: 'TESTSENTINEL', now: () => h.clock });
  // Any seeded thread makes the fake answer `GET /repos/{repo}` with its owner (the owner-writer check).
  fake.seedIssue({ repo: REPO, number: 22, title: 'Team run log', author: OWNER.login, repoOwner: OWNER });
  fake.seedMilestones(REPO, milestones);
  const stub = stubGitHub(async (call) => {
    const answer = h.before?.(call);
    if (answer !== undefined) {
      return answer;
    }
    if (call.url.pathname === `/repos/${REPO}/contents/.product-team/project.yml`) {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: projectYml.length,
        content: base64(projectYml),
      });
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

async function call(h: Harness, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  return fetchApi(`/api/v1/projects/tc${path}`, localEnv(), {
    method,
    headers: method === 'POST' ? WRITE_HEADERS : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    github: h.github,
  });
}

const moveDemo = (h: Harness, due: string, expectedDue = '2026-10-14'): Promise<Response> =>
  call(h, 'POST', '/sprint/demo-date', { due, expectedDue });
const nextSprint = (
  h: Harness,
  due: string,
  expectedCurrent: string | null = 'Sprint 04',
): Promise<Response> => call(h, 'POST', '/sprint/next', { due, expectedCurrent });

async function problemOf(
  response: Response,
): Promise<{ slug: string | null; body: Record<string, unknown> }> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem: ${JSON.stringify(body)}`);
  }
  return { slug: problemSlugOf(body.type), body };
}

/** Every call that was not a read: the milestone writes. */
function writes(h: Harness): string[] {
  return h.calls
    .filter((c) => c.method !== 'GET' && !c.url.pathname.startsWith('/app/'))
    .map((c) => `${c.method} ${c.url.pathname} ${c.body ?? ''}`);
}

beforeEach(async () => {
  await resetProjects();
  await resetOwnerConnections();
  await seedProject('tc', REPO);
});

describe('POST /sprint/demo-date', () => {
  it('moves the current sprint with the owner token, byte-for-byte as backlog sprint create writes due_on', async () => {
    const h = harness();
    const { accessToken } = await seedConnection(h.fake, { nowMs: h.clock });

    const response = await moveDemo(h, '2026-10-16');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      sprint: { number: 4, title: 'Sprint 04', due: '2026-10-16' },
      freeze: { from: '2026-10-14', to: '2026-10-16' },
      freezeStartsNow: false,
    });
    expect(writes(h)).toEqual([`PATCH /repos/${REPO}/milestones/4 {"due_on":"2026-10-16T12:00:00Z"}`]);
    const patch = h.calls.find((c) => c.method === 'PATCH');
    expect(patch?.headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(h.fake.milestonesOf(REPO).find((m) => m.number === 4)?.dueOn).toBe('2026-10-16T12:00:00Z');
    // The milestones are read live with the installation token, open and closed.
    const read = h.calls.find((c) => c.method === 'GET' && c.url.pathname === `/repos/${REPO}/milestones`);
    expect(read?.url.searchParams.get('state')).toBe('all');
    expect(read?.headers.get('authorization')).toMatch(/^Bearer ghs_TESTSENTINEL/);
  });

  it('stays within the subrequest budget: 5 with project.yml cached, 6 on a cold isolate', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    await moveDemo(h, '2026-10-16');
    // installation lookup + mint, milestones, project.yml, repository (owner check), PATCH
    expect(h.calls).toHaveLength(6);
    h.calls.length = 0;
    await moveDemo(h, '2026-10-15', '2026-10-16');
    // The token and project.yml are cached now: milestones, repository, PATCH.
    expect(h.calls.length).toBeLessThanOrEqual(5);
  });

  it('says when the freeze starts at once (today inside the new freeze, freeze_days from project.yml)', async () => {
    const h = harness(SPRINTS, 'sprint:\n  freeze_days: 3\n');
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await moveDemo(h, '2026-10-08');
    await expect(response.json()).resolves.toMatchObject({
      freeze: { from: '2026-10-05', to: '2026-10-08' },
      freezeStartsNow: true,
    });
  });

  it('answers a due that changed meanwhile with 409 and the live due; nothing is written', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    // The PM moved the demo after the owner opened the form.
    h.fake.seedMilestones(REPO, [
      SPRINTS[0] as FakeMilestoneSeed,
      { number: 4, title: 'Sprint 04', dueOn: '2026-10-15T12:00:00Z' },
    ]);

    const response = await moveDemo(h, '2026-10-20');

    expect(response.status).toBe(409);
    await expect(problemOf(response)).resolves.toMatchObject({
      slug: 'sprint-changed',
      body: { due: '2026-10-15' },
    });
    expect(writes(h)).toEqual([]);
  });

  it.each([
    ['no current sprint', [SPRINTS[0]], '2026-10-16', '2026-10-14', 409, 'sprint-none', {}],
    ['the same day', SPRINTS, '2026-10-14', '2026-10-14', 409, 'sprint-unchanged', {}],
    [
      'yesterday in Kyiv',
      SPRINTS,
      '2026-10-04',
      '2026-10-14',
      422,
      'sprint-date-past',
      { today: '2026-10-05' },
    ],
    [
      'the next sprint demo day',
      [...SPRINTS, { number: 5, title: 'Sprint 05', dueOn: '2026-10-28T12:00:00Z' }],
      '2026-10-28',
      '2026-10-14',
      422,
      'sprint-date-after-next',
      { nextTitle: 'Sprint 05', nextDue: '2026-10-28' },
    ],
  ])('refuses %s without writing', async (_label, milestones, due, expectedDue, status, slug, extensions) => {
    const h = harness(milestones as FakeMilestoneSeed[]);
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await moveDemo(h, due, expectedDue);
    expect(response.status).toBe(status);
    await expect(problemOf(response)).resolves.toMatchObject({ slug, body: extensions });
    expect(writes(h)).toEqual([]);
  });

  it('reads "past" on the Kyiv calendar: at 01:30 in Kyiv the UTC date is still yesterday', async () => {
    const h = harness();
    h.clock = Date.parse('2026-10-05T22:30:00.000Z');
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await moveDemo(h, '2026-10-05');
    expect(response.status).toBe(422);
    await expect(problemOf(response)).resolves.toMatchObject({
      slug: 'sprint-date-past',
      body: { today: '2026-10-06' },
    });
  });

  it.each([
    ['no body', undefined],
    ['a date that does not exist', { due: '2026-02-30', expectedDue: '2026-10-14' }],
    ['a timestamp', { due: '2026-10-16T12:00:00Z', expectedDue: '2026-10-14' }],
    ['no expectedDue', { due: '2026-10-16' }],
    ['an extra member', { due: '2026-10-16', expectedDue: '2026-10-14', number: 9 }],
  ])('answers 422 validation for %s before GitHub is asked', async (_label, body) => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await call(h, 'POST', '/sprint/demo-date', body);
    expect(response.status).toBe(422);
    await expect(problemOf(response)).resolves.toMatchObject({ slug: 'validation' });
    expect(h.calls).toEqual([]);
  });

  it('never repeats a PATCH GitHub failed with a 5xx', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    h.before = (c) => (c.method === 'PATCH' ? json(502, { message: 'unavailable' }) : undefined);
    const response = await moveDemo(h, '2026-10-16');
    expect(response.status).toBe(502);
    expect(writes(h)).toHaveLength(1);
  });
});

describe('POST /sprint/next', () => {
  it('creates Sprint NN+1 (highest, closed included) with the owner token, byte-for-byte', async () => {
    const h = harness([
      { number: 1, title: 'Sprint 07', state: 'closed', dueOn: '2026-09-16T12:00:00Z' },
      { number: 4, title: 'Sprint 04', dueOn: '2026-10-14T12:00:00Z' },
    ]);
    const { accessToken } = await seedConnection(h.fake, { nowMs: h.clock });

    const response = await nextSprint(h, '2026-10-28');

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sprint: { number: 5, title: 'Sprint 08', due: '2026-10-28' },
      becomesCurrentAfter: '2026-10-14',
    });
    expect(writes(h)).toEqual([
      `POST /repos/${REPO}/milestones {"title":"Sprint 08","due_on":"2026-10-28T12:00:00Z"}`,
    ]);
    expect(
      h.calls
        .find((c) => c.method === 'POST' && c.url.pathname.endsWith('/milestones'))
        ?.headers.get('authorization'),
    ).toBe(`Bearer ${accessToken}`);
  });

  it('creates Sprint 01 that is current at once in a repository without sprints', async () => {
    const h = harness([{ title: 'Launch', dueOn: null }]);
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await nextSprint(h, '2026-10-19', null);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sprint: { number: 2, title: 'Sprint 01', due: '2026-10-19' },
      becomesCurrentAfter: null,
    });
  });

  it('answers 409 sprint-exists when the next sprint is there already', async () => {
    const h = harness([...SPRINTS, { number: 5, title: 'Sprint 05', dueOn: '2026-10-28T12:00:00Z' }]);
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await nextSprint(h, '2026-11-11');
    expect(response.status).toBe(409);
    await expect(problemOf(response)).resolves.toMatchObject({
      slug: 'sprint-exists',
      body: { nextTitle: 'Sprint 05', nextDue: '2026-10-28' },
    });
    expect(writes(h)).toEqual([]);
  });

  it('maps GitHub 422 already_exists (the PM created it first) to 409 sprint-exists', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    h.before = (c) => {
      if (c.method === 'POST' && c.url.pathname.endsWith('/milestones')) {
        h.fake.seedMilestones(REPO, [
          ...SPRINTS,
          { number: 5, title: 'Sprint 05', dueOn: '2026-10-27T12:00:00Z' },
        ]);
      }
      return undefined;
    };
    const response = await nextSprint(h, '2026-10-28');
    expect(response.status).toBe(409);
    await expect(problemOf(response)).resolves.toMatchObject({
      slug: 'sprint-exists',
      body: { nextTitle: 'Sprint 05', nextDue: null },
    });
    expect(h.fake.milestonesOf(REPO).filter((m) => m.title === 'Sprint 05')).toHaveLength(1);
  });

  it('answers a changed current sprint with 409 and the live one; nothing is written', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await nextSprint(h, '2026-10-28', null);
    expect(response.status).toBe(409);
    await expect(problemOf(response)).resolves.toMatchObject({
      slug: 'sprint-changed',
      body: { currentTitle: 'Sprint 04', currentDue: '2026-10-14' },
    });
    expect(writes(h)).toEqual([]);
  });

  it.each([
    ['on the current demo day', '2026-10-14'],
    ['before it', '2026-10-10'],
  ])('refuses a demo %s with 422 sprint-date-early', async (_label, due) => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    const response = await nextSprint(h, due);
    expect(response.status).toBe(422);
    await expect(problemOf(response)).resolves.toMatchObject({
      slug: 'sprint-date-early',
      body: { after: '2026-10-14' },
    });
    expect(writes(h)).toEqual([]);
  });

  it.each([
    ['a number for expectedCurrent', { due: '2026-10-28', expectedCurrent: 4 }],
    ['a missing expectedCurrent', { due: '2026-10-28' }],
    ['a title too long', { due: '2026-10-28', expectedCurrent: 'S'.repeat(256) }],
  ])('answers 422 validation for %s', async (_label, body) => {
    const h = harness();
    const response = await call(h, 'POST', '/sprint/next', body);
    expect(response.status).toBe(422);
    expect(h.calls).toEqual([]);
  });
});

describe('who may write', () => {
  it.each([
    ['/sprint/demo-date', { due: '2026-10-16', expectedDue: '2026-10-14' }],
    ['/sprint/next', { due: '2026-10-28', expectedCurrent: 'Sprint 04' }],
  ])('POST %s without the owner connection answers 403 with zero GitHub calls', async (path, body) => {
    const h = harness();
    const response = await call(h, 'POST', path, body);
    expect(response.status).toBe(403);
    await expect(problemOf(response)).resolves.toMatchObject({ slug: 'github-owner-not-connected' });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['/sprint/demo-date', { due: '2026-10-16', expectedDue: '2026-10-14' }],
    ['/sprint/next', { due: '2026-10-28', expectedCurrent: 'Sprint 04' }],
  ])(
    'POST %s as the Access service identity answers 403 owner-only; nothing read or written',
    async (path, body) => {
      const h = harness();
      await seedConnection(h.fake, { nowMs: h.clock, environment: 'dev' });
      const jwks = stubJwksServer();
      const teamDomain = uniqueTeamDomain();
      const key = await createSigningKey();
      jwks.set(teamDomain, { keys: [key.publicJwk] });
      const token = await signAccessToken(key, teamDomain, {
        claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
      });
      const response = await fetchApi(
        `/api/v1/projects/tc${path}`,
        accessEnv(teamDomain, { ENVIRONMENT: 'dev' }),
        {
          method: 'POST',
          headers: { ...WRITE_HEADERS, 'Cf-Access-Jwt-Assertion': token },
          body: JSON.stringify(body),
          github: h.github,
        },
      );
      expect(response.status).toBe(403);
      await expect(problemOf(response)).resolves.toMatchObject({ slug: 'owner-only' });
      expect(h.calls).toEqual([]);
    },
  );
});

describe('GET /team/status: sprint and progress (#218)', () => {
  const RUN_LOG_YML = `${PROJECT_YML}team:\n  run_log_issue: 22\n`;

  it('shows the current sprint with its freeze, the next sprint and done / total', async () => {
    const h = harness(
      [...SPRINTS, { number: 5, title: 'Sprint 05', dueOn: '2026-10-28T12:00:00Z' }],
      RUN_LOG_YML,
    );
    await seedConnection(h.fake, { nowMs: h.clock });
    const issues = [
      { number: 41, state: 'closed', labels: ['kind:feature', 'status:done'] },
      { number: 42, state: 'open', labels: ['kind:feature', 'status:in-progress'] },
      { number: 43, state: 'open', labels: ['kind:bug', 'status:ready'] },
      { number: 44, state: 'open', labels: ['ux-spec'] },
    ];
    h.before = (c) =>
      c.url.pathname === `/repos/${REPO}/issues` && c.url.searchParams.get('milestone') === '4'
        ? json(
            200,
            issues.map((issue) => ({
              ...issue,
              title: `Issue ${issue.number}`,
              html_url: `https://github.com/${REPO}/issues/${issue.number}`,
              labels: issue.labels.map((name) => ({ name })),
              user: { login: OWNER.login, type: 'User' },
              author_association: 'OWNER',
            })),
          )
        : undefined;
    const status = (await (await call(h, 'GET', '/team/status')).json()) as TeamStatusDto;
    expect(status.sprint).toEqual({
      number: 4,
      title: 'Sprint 04',
      due: '2026-10-14',
      freeze: { from: '2026-10-12', to: '2026-10-14' },
      next: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
    });
    expect(status.progress).toEqual({ done: 1, total: 3 });
    expect(status.calendar).toEqual({ today: '2026-10-05', freezeDays: 2, nextTitle: 'Sprint 06' });
  });

  it('keeps answering without the sprint when GitHub refuses the milestones', async () => {
    const h = harness(SPRINTS, RUN_LOG_YML);
    await seedConnection(h.fake, { nowMs: h.clock });
    h.before = (c) =>
      c.url.pathname === `/repos/${REPO}/milestones` ? json(503, { message: 'down' }) : undefined;
    const response = await call(h, 'GET', '/team/status');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sprint: null, progress: null, calendar: null });
  });

  it('has no sprint and no progress, but a calendar, when no sprint is running', async () => {
    const h = harness([SPRINTS[0] as FakeMilestoneSeed], RUN_LOG_YML);
    await seedConnection(h.fake, { nowMs: h.clock });
    const status = (await (await call(h, 'GET', '/team/status')).json()) as TeamStatusDto;
    expect(status).toMatchObject({
      sprint: null,
      progress: null,
      calendar: { today: '2026-10-05', freezeDays: 2, nextTitle: 'Sprint 04' },
    });
  });
});

afterAll(async () => {
  await env.DB.prepare('DELETE FROM owner_connections').run();
});
