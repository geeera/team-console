import { env } from 'cloudflare:test';
import type { OverviewDto, OverviewProjectDto, OverviewProjectReadDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
  type ReadHandler,
  type StubGitHub,
} from '../testing/github-kit';
import {
  RUN_LOG_ISSUE,
  issue,
  runEntry,
  runLogGitHub,
  runLogIssueOf,
  type RunLogCommentSeed,
  type RunLogRepoState,
} from '../testing/read-model-kit';
import { OVERVIEW_GITHUB_BUDGET } from './overview';

// #27: the all-projects overview — one row per active project, a failing project confined to its row, and the
// request's GitHub subrequests bounded however many projects there are.

const PATH = '/api/v1/overview';
const NOW = Date.parse('2026-10-01T12:00:00Z');
const LOG = RUN_LOG_ISSUE;
const OWNER = 'geeera';
/** The Workers free plan's subrequests per request. */
const WORKER_SUBREQUEST_LIMIT = 50;

type Repo = RunLogRepoState;

const run = (id: string, state: string, minutesAgo: number): RunLogCommentSeed =>
  runEntry(id, state, minutesAgo);

function sprintIssue(number: number, labels: string[], state: 'open' | 'closed'): Record<string, unknown> {
  return issue(number, labels, { state, milestone: { number: 3 }, user: { login: OWNER } });
}

/** A project mid-sprint: two questions, 2 of 3 work items closed, the team running. */
function activeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    issues: [
      issue(7, ['kind:question'], { user: { login: OWNER } }),
      issue(9, ['needs:owner', 'kind:chore'], { user: { login: OWNER } }),
      sprintIssue(31, ['kind:feature', 'status:done'], 'closed'),
      sprintIssue(32, ['kind:bug', 'status:done'], 'closed'),
      sprintIssue(33, ['kind:feature', 'status:in-progress'], 'open'),
      sprintIssue(34, ['kind:question'], 'open'),
    ],
    milestones: [
      {
        number: 3,
        title: 'Sprint 03 <b>bold</b>',
        state: 'open',
        due_on: '2026-10-16T00:00:00Z',
        html_url: 'https://github.com/geeera/x/milestone/3',
      },
    ],
    log: [run('r1', 'started', 120), run('r1', 'finished', 100)],
    ...overrides,
  };
}

const overviewGitHub = (repos: Readonly<Record<string, Repo>>): ReadHandler => runLogGitHub(repos, NOW);

async function seedRepos(repos: Readonly<Record<string, Repo>>): Promise<void> {
  for (const name of Object.keys(repos)) {
    await seedProject(name.split('/')[1] ?? name, name);
  }
}

async function overview(github: ApiGitHub): Promise<OverviewDto> {
  const response = await fetchApi(PATH, localEnv(), { github });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

function read(row: OverviewProjectDto | undefined): OverviewProjectReadDto {
  if (row?.kind !== 'read') {
    throw new Error(`expected a read row, got ${JSON.stringify(row)}`);
  }
  return row;
}

const githubOf = (stub: StubGitHub): ApiGitHub => new ApiGitHub({ fetch: stub.fetch, now: () => NOW });

beforeEach(async () => {
  await resetProjects();
});

describe('GET /api/v1/overview', () => {
  it('answers one row per active project with the team, the sprint, what waits and the setup', async () => {
    const repos: Record<string, Repo> = {
      'geeera/alpha': activeRepo(),
      'geeera/beta': { projectYml: 'name: beta\n', issues: [], milestones: [] },
    };
    await seedRepos(repos);
    const body = await overview(githubOf(stubGitHub(overviewGitHub(repos))));

    expect(body.checkedAt).toBe(new Date(NOW).toISOString());
    expect(body.projects.map((row) => row.slug)).toEqual(['alpha', 'beta']);
    expect(read(body.projects[0])).toEqual({
      kind: 'read',
      slug: 'alpha',
      name: 'alpha',
      team: 'running',
      // Milestone text passes through verbatim; the client renders it as plain text.
      sprint: { number: 3, title: 'Sprint 03 <b>bold</b>', dueOn: '2026-10-16', planned: 3, shipped: 2 },
      needsYou: [7, 34, 9],
      setup: false,
      setupUrl: null,
    });
    expect(read(body.projects[1])).toMatchObject({
      team: 'running',
      sprint: null,
      needsYou: [],
      setup: true,
      setupUrl: 'https://github.com/geeera/beta/blob/HEAD/.product-team/owner-checklist.md',
    });
  });

  it('leaves archived projects out', async () => {
    const repos = { 'geeera/alpha': activeRepo(), 'geeera/old': activeRepo() };
    await seedRepos(repos);
    await env.DB.prepare("UPDATE projects SET archived_at = '2026-09-30T00:00:00Z' WHERE slug = 'old'").run();
    const body = await overview(githubOf(stubGitHub(overviewGitHub(repos))));
    expect(body.projects.map((row) => row.slug)).toEqual(['alpha']);
  });

  it.each([
    [
      'an owner pause',
      {
        logLabels: ['team:run-log', 'team:paused'],
        log: [
          {
            body: '<!-- pt-paused -->\n<!-- pt-owner-pause {"reason": "", "source": "team-console"} -->\npaused',
            minutesAgo: 30,
          },
        ],
      },
      'paused',
    ],
    [
      'the team stopping itself',
      {
        logLabels: ['team:run-log', 'team:paused'],
        log: [
          run('a', 'failed', 90),
          run('b', 'failed', 60),
          run('c', 'failed', 40),
          { body: '<!-- pt-paused -->\n**Team paused**', minutesAgo: 30 },
        ],
      },
      'failing',
    ],
    [
      'three failed runs before the next start pauses',
      { log: [run('a', 'failed', 90), run('b', 'failed', 60), run('c', 'failed', 40)] },
      'failing',
    ],
    [
      'a /resume from the owner after the team stopped itself',
      {
        logLabels: ['team:run-log', 'team:paused'],
        log: [
          run('a', 'failed', 90),
          run('b', 'failed', 60),
          run('c', 'failed', 40),
          { body: '<!-- pt-paused -->\n**Team paused**', minutesAgo: 30 },
          { body: '/resume', minutesAgo: 10 },
        ],
      },
      'running',
    ],
    [
      'failures before the last resume',
      {
        log: [
          run('a', 'failed', 90),
          run('b', 'failed', 60),
          run('c', 'failed', 40),
          { body: '<!-- pt-owner-resume -->\n**Development resumed**', minutesAgo: 30 },
        ],
      },
      'running',
    ],
    [
      'a /resume from someone else',
      {
        logLabels: ['team:run-log', 'team:paused'],
        log: [
          { body: '<!-- pt-paused -->\n**Team paused**', minutesAgo: 30 },
          { body: '/resume', minutesAgo: 10, author: 'outsider' },
        ],
      },
      'failing',
    ],
  ] as const)('reads the team state from the run log as runstate does: %s', async (_case, log, expected) => {
    const repos = { 'geeera/alpha': activeRepo(log) };
    await seedRepos(repos);
    const body = await overview(githubOf(stubGitHub(overviewGitHub(repos))));
    expect(read(body.projects[0]).team).toBe(expected);
  });

  it('shows a run log someone outside the team opened as unknown, not as running', async () => {
    const repos = {
      'geeera/alpha': activeRepo({
        projectYml: "name: x\nteam:\n  run_log_issue: 22\n  reviewer_logins: ['r[bot]']\n",
      }),
    };
    await seedRepos(repos);
    const handler = overviewGitHub(repos);
    const stub = stubGitHub((call) =>
      call.url.pathname === `/repos/geeera/alpha/issues/${LOG}`
        ? json(200, { ...runLogIssueOf('geeera/alpha', repos['geeera/alpha']), user: { login: 'outsider' } })
        : handler(call),
    );
    const body = await overview(githubOf(stub));
    expect(read(body.projects[0]).team).toBe('unknown');
  });

  it('reads only the latest two pages of a long run log', async () => {
    const repos = { 'geeera/alpha': activeRepo({ logCommentCount: 450 }) };
    await seedRepos(repos);
    const stub = stubGitHub(overviewGitHub(repos));
    await overview(githubOf(stub));
    const comments = stub.reads().filter((call) => call.url.pathname.endsWith('/comments'));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.url.searchParams.get('page')).toBe('4');
  });

  it('shows a failing project in its own row and still reads the others', async () => {
    const repos = {
      'geeera/alpha': activeRepo(),
      'geeera/broken': activeRepo(),
      'geeera/gamma': activeRepo(),
    };
    await seedRepos(repos);
    const ok = stubGitHub(overviewGitHub(repos));
    const notInstalled = stubGitHub(overviewGitHub(repos), () => json(404, {}));
    const github = new ApiGitHub({
      now: () => NOW,
      fetch: async (input, init) =>
        input.includes('/repos/geeera/broken/') ? notInstalled.fetch(input, init) : ok.fetch(input, init),
    });
    const body = await overview(github);

    expect(body.projects.map((row) => [row.slug, row.kind])).toEqual([
      ['alpha', 'read'],
      ['broken', 'failed'],
      ['gamma', 'read'],
    ]);
    expect(body.projects[1]).toEqual({
      kind: 'failed',
      slug: 'broken',
      name: 'broken',
      problem: {
        type: 'github-app-not-installed',
        title: 'The console app is not installed on this repository',
        status: 409,
      },
    });
  });

  it('keeps a rate-limited project to its row', async () => {
    const repos = { 'geeera/alpha': activeRepo(), 'geeera/limited': activeRepo() };
    await seedRepos(repos);
    const handler = overviewGitHub(repos);
    const stub = stubGitHub((call) =>
      call.url.pathname.startsWith('/repos/geeera/limited/')
        ? json(429, {}, { 'retry-after': '30' })
        : handler(call),
    );
    const body = await overview(githubOf(stub));
    expect(body.projects.map((row) => (row.kind === 'read' ? 'read' : row.problem.type))).toEqual([
      'read',
      'github-rate-limit',
    ]);
  });

  it('reports an unusable project.yml per project', async () => {
    const repos = {
      'geeera/alpha': activeRepo(),
      'geeera/bad-yml': activeRepo({ projectYml: 'a: &a [x]\nb: *a\n' }),
    };
    await seedRepos(repos);
    const body = await overview(githubOf(stubGitHub(overviewGitHub(repos))));
    expect(body.projects.map((row) => (row.kind === 'read' ? 'read' : row.problem.type))).toEqual([
      'read',
      'project-config-invalid',
    ]);
  });

  it(`stays within ${OVERVIEW_GITHUB_BUDGET} GitHub subrequests for 12 cold projects and goes on from the cache`, async () => {
    const repos: Record<string, Repo> = {};
    for (let i = 1; i <= 12; i += 1) {
      repos[`geeera/p${String(i).padStart(2, '0')}`] = activeRepo();
    }
    await seedRepos(repos);
    const stub = stubGitHub(overviewGitHub(repos));
    const github = githubOf(stub);

    const rounds: { calls: number; read: number }[] = [];
    let body: OverviewDto | undefined;
    for (
      let round = 0;
      round < 6 && body?.projects.every((row) => row.kind === 'read') !== true;
      round += 1
    ) {
      const before = stub.calls.length;
      body = await overview(github);
      rounds.push({
        calls: stub.calls.length - before,
        read: body.projects.filter((row) => row.kind === 'read').length,
      });
      expect(body.projects).toHaveLength(12);
      for (const row of body.projects) {
        if (row.kind === 'failed') {
          expect(row.problem.type).toBe('github-request-budget');
        }
      }
    }

    // Plus the registry query and the Access key set: under the Workers limit of 50.
    for (const { calls } of rounds) {
      expect(calls).toBeLessThanOrEqual(OVERVIEW_GITHUB_BUDGET);
      expect(calls + 2).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
    }
    // The first request already shows several projects in full; registry order comes first.
    expect(rounds[0]?.read).toBeGreaterThanOrEqual(4);
    expect(body?.projects[0]?.kind).toBe('read');
    // Every request makes progress until all twelve are shown.
    expect(rounds.at(-1)?.read).toBe(12);
    expect(rounds.map((r) => r.read)).toEqual([...rounds.map((r) => r.read)].sort((a, b) => a - b));

    const before = stub.calls.length;
    await overview(github);
    expect(stub.calls.length - before).toBe(0);
  });

  it('shares the read cache with Needs you and the board: a warm project costs nothing', async () => {
    const repos = { 'geeera/alpha': activeRepo() };
    await seedRepos(repos);
    const stub = stubGitHub(overviewGitHub(repos));
    const github = githubOf(stub);
    await fetchApi('/api/v1/needs-you', localEnv(), { github });
    await fetchApi('/api/v1/projects/alpha/sprint', localEnv(), { github });
    const before = stub.reads().length;
    await overview(github);
    // The board read the run log already (#132): the overview's team state is the same cache entry.
    expect(
      stub
        .reads()
        .slice(before)
        .map((call) => call.url.pathname.split('/').slice(4).join('/')),
    ).toEqual([]);
  });
});
