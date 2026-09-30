import {
  PROBLEM_TYPE_PREFIX,
  isProblemDetails,
  type InboxDto,
  type QuestionsDto,
  type SprintDto,
} from '@shared/contracts';
import { MemoryReadCache } from '@worker/github';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type StubGitHub,
} from '../testing/github-kit';
import { issue, readModelGitHub, type RepoState } from '../testing/read-model-kit';

// #35 through the routes: DTOs, subrequest counts, the read cache, project.yml checks and slug checks.

const OPEN_ISSUES = [
  issue(31, ['team:inbox']),
  issue(22, ['team:run-log']),
  issue(46, ['status:blocked', 'kind:chore', 'needs:owner'], {
    body: '**Your answer:** Напиши «сделал», когда переключишь источник GitHub Pages\n\nтекст',
  }),
  issue(21, ['status:blocked', 'kind:chore', 'needs:owner'], { author_association: 'COLLABORATOR' }),
  issue(72, ['kind:question', 'owner:scope'], {
    body: '**Your answer:** /approve the plan (recommended) · /reject what to change\n<!-- pt-ask -->',
  }),
  issue(99, ['kind:question'], {
    title: '<img src=x onerror=alert(1)>',
    author_association: 'NONE',
    html_url: 'javascript:alert(1)',
  }),
  issue(45, ['needs:owner'], {
    pull_request: { html_url: 'https://github.com/geeera/team-console/pull/45' },
  }),
  issue(10, ['kind:chore', 'status:in-progress']),
];

function setup(state: RepoState = { issues: OPEN_ISSUES }): { github: ApiGitHub; stub: StubGitHub } {
  const stub = stubGitHub(readModelGitHub({ 'geeera/team-console': state }));
  return { stub, github: new ApiGitHub({ fetch: stub.fetch }) };
}

async function problemType(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error('not a problem');
  }
  return body.type.slice(PROBLEM_TYPE_PREFIX.length);
}

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', 'geeera/team-console');
});

describe('GET /api/v1/projects/:slug/inbox', () => {
  it('returns the plugin inbox as a DTO, with trust and safe urls, in 4 subrequests on a cold isolate', async () => {
    const { github, stub } = setup();
    const response = await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });

    expect(response.status).toBe(200);
    const body = (await response.json()) as InboxDto;
    expect(body).toEqual({
      items: [
        {
          section: 'question',
          number: 72,
          title: 'Issue 72',
          url: 'https://github.com/geeera/team-console/issues/72',
          ask: '/approve the plan (recommended) · /reject what to change',
          authorTrusted: true,
        },
        {
          section: 'question',
          number: 99,
          title: '<img src=x onerror=alert(1)>',
          url: null,
          ask: null,
          authorTrusted: false,
        },
        {
          section: 'owner',
          number: 21,
          title: 'Issue 21',
          url: 'https://github.com/geeera/team-console/issues/21',
          ask: null,
          authorTrusted: true,
        },
        {
          section: 'owner',
          number: 46,
          title: 'Issue 46',
          url: 'https://github.com/geeera/team-console/issues/46',
          ask: 'Напиши «сделал», когда переключишь источник GitHub Pages',
          authorTrusted: true,
        },
      ],
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
    });
    // installation lookup, mint, open issues, project.yml
    expect(stub.calls).toHaveLength(4);
    expect(stub.reads().map((call) => `${call.url.pathname}${call.url.search}`)).toEqual(
      expect.arrayContaining([
        '/repos/geeera/team-console/issues?state=open&per_page=100',
        '/repos/geeera/team-console/contents/.product-team/project.yml',
      ]),
    );
  });

  it('serves inbox, questions and a second inbox from the read cache (0 more subrequests)', async () => {
    const { github, stub } = setup();
    await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });
    await fetchApi('/api/v1/projects/tc/questions', localEnv(), { github });
    await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });
    expect(stub.calls).toHaveLength(4);
  });

  it('refetches the issues after 60 s but project.yml only after 600 s', async () => {
    let now = Date.now();
    const stub = stubGitHub(readModelGitHub({ 'geeera/team-console': { issues: OPEN_ISSUES } }));
    const github = new ApiGitHub({ fetch: stub.fetch, readCache: new MemoryReadCache({ now: () => now }) });
    await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });
    now += 61_000;
    await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });
    const paths = stub.reads().map((call) => call.url.pathname);
    expect(paths.filter((p) => p.endsWith('/issues'))).toHaveLength(2);
    expect(paths.filter((p) => p.includes('/contents/'))).toHaveLength(1);
  });

  it('shows the security setup item while reviewer_logins is empty or project.yml is missing', async () => {
    for (const projectYml of ['name: x\nteam:\n  reviewer_logins: []\n', null]) {
      const { github } = setup({ issues: OPEN_ISSUES, projectYml });
      const body = (await (
        await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github })
      ).json()) as InboxDto;
      expect(body.setup).toBe(true);
      expect(body.setupUrl).toBe(
        'https://github.com/geeera/team-console/blob/HEAD/.product-team/owner-checklist.md',
      );
    }
  });

  it('is paused while the run log carries team:paused', async () => {
    const { github } = setup({ issues: [...OPEN_ISSUES, issue(23, ['team:run-log', 'team:paused'])] });
    const body = (await (
      await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github })
    ).json()) as InboxDto;
    expect(body).toMatchObject({
      paused: true,
      pausedUrl: 'https://github.com/geeera/team-console/issues/23',
    });
  });

  it.each([
    [
      'a 1 MB file (the contents API sends no content)',
      { contents: () => json(200, { type: 'file', encoding: 'none', size: 1_048_576, content: '' }) },
    ],
    ['a file over 64 KB', { projectYml: `name: x\n#${'a'.repeat(70 * 1024)}\n` }],
    [
      'an alias bomb',
      {
        projectYml:
          'a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nteam:\n  reviewer_logins: *c\n',
      },
    ],
    ['a custom tag', { projectYml: 'team: !include x.yml\n' }],
    ['reviewer_logins that are not logins', { projectYml: "team:\n  reviewer_logins: ['']\n" }],
  ])('%s → 422 project-config-invalid', async (_label, state) => {
    const { github } = setup({ issues: OPEN_ISSUES, ...state });
    const response = await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });
    expect(response.status).toBe(422);
    expect(await problemType(response)).toBe('project-config-invalid');
  });

  it('surfaces a GitHub rate limit as 429 with Retry-After', async () => {
    const stub = stubGitHub(() => json(403, {}, { 'x-ratelimit-remaining': '0', 'retry-after': '42' }));
    const response = await fetchApi('/api/v1/projects/tc/inbox', localEnv(), {
      github: new ApiGitHub({ fetch: stub.fetch }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(await problemType(response)).toBe('github-rate-limit');
  });

  it('never reads project.yml outside api.github.com (no raw.githubusercontent.com)', async () => {
    const { github, stub } = setup();
    await fetchApi('/api/v1/projects/tc/inbox', localEnv(), { github });
    expect(stub.calls.every((call) => call.url.origin === 'https://api.github.com')).toBe(true);
  });
});

describe('GET /api/v1/projects/:slug/questions', () => {
  it('lists the inbox items as cards with body and the allowed answers', async () => {
    const { github } = setup();
    const body = (await (
      await fetchApi('/api/v1/projects/tc/questions', localEnv(), { github })
    ).json()) as QuestionsDto;
    expect(body.items.map((item) => [item.number, item.allowedCommands])).toEqual([
      [72, ['approve', 'reject']],
      [99, ['approve', 'reject']],
      [21, ['done']],
      [46, ['done']],
    ]);
    expect(body.items[0]?.body).toBe(
      '**Your answer:** /approve the plan (recommended) · /reject what to change\n<!-- pt-ask -->',
    );
  });
});

describe('GET /api/v1/projects/:slug/sprint', () => {
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const sprintState: RepoState = {
    issues: [
      issue(1, ['kind:feature', 'tier:light', 'status:in-progress'], { milestone: { number: 7 } }),
      issue(2, ['kind:chore', 'status:done'], { milestone: { number: 7 }, state: 'closed' }),
      issue(3, ['kind:question'], { milestone: { number: 8 } }),
    ],
    milestones: [
      {
        number: 8,
        title: 'Sprint 02',
        state: 'open',
        due_on: `${later}T00:00:00Z`,
        html_url: 'https://github.com/geeera/team-console/milestone/8',
      },
      {
        number: 7,
        title: 'Sprint 01',
        state: 'open',
        due_on: `${future}T00:00:00Z`,
        html_url: 'https://github.com/geeera/team-console/milestone/7',
      },
    ],
    pulls: [
      {
        number: 5,
        title: 'feat: x',
        html_url: 'https://github.com/geeera/team-console/pull/5',
        draft: false,
        author_association: 'OWNER',
      },
    ],
  };

  it('returns the current sprint board in 5 subrequests on a cold isolate', async () => {
    const { github, stub } = setup(sprintState);
    const response = await fetchApi('/api/v1/projects/tc/sprint', localEnv(), { github });
    expect(response.status).toBe(200);
    const body = (await response.json()) as SprintDto;
    expect(body).toMatchObject({
      milestone: { number: 7, title: 'Sprint 01', dueOn: future },
      byStatus: { 'in-progress': 1, done: 1 },
      planned: 2,
      shipped: 1,
      carriedOver: 1,
      byTier: {
        light: { planned: 1, shipped: 0, raised: 0 },
        unsized: { planned: 1, shipped: 1, raised: 0 },
      },
      openPullRequests: [
        {
          number: 5,
          title: 'feat: x',
          url: 'https://github.com/geeera/team-console/pull/5',
          draft: false,
          authorTrusted: true,
        },
      ],
    });
    expect(body.issues.map((i) => [i.number, i.status, i.tier, i.state])).toEqual([
      [1, 'in-progress', 'light', 'open'],
      [2, 'done', 'standard', 'closed'],
    ]);
    // installation lookup, mint, milestones, open pulls, the sprint's issues
    expect(stub.calls).toHaveLength(5);
  });

  it('without a dated open milestone answers an empty board', async () => {
    const { github } = setup({ milestones: [] });
    const body = (await (
      await fetchApi('/api/v1/projects/tc/sprint', localEnv(), { github })
    ).json()) as SprintDto;
    expect(body.milestone).toBeNull();
    expect(body.issues).toEqual([]);
  });
});

describe('the slug is checked before any fetch (#9 row 2)', () => {
  it.each(['inbox', 'questions', 'sprint'])('%s', async (route) => {
    for (const slug of ['tc%2F..%2Fx', '..', '%2e%2e', 'tc%2Fx', 'a/b', 'TC']) {
      const { github, stub } = setup();
      const response = await fetchApi(`/api/v1/projects/${slug}/${route}`, localEnv(), { github });
      expect(response.status, slug).toBe(404);
      expect(stub.calls, slug).toHaveLength(0);
    }
  });

  it('answers project-not-found for an unknown slug', async () => {
    const { github } = setup();
    const response = await fetchApi('/api/v1/projects/nope/inbox', localEnv(), { github });
    expect(await problemType(response)).toBe('project-not-found');
  });
});

describe('mock mode (local only) serves the product-shaped fixtures', () => {
  it('lists the owner items and the untrusted outsider question of the team-console fixture', async () => {
    const response = await fetchApi('/api/v1/projects/tc/inbox', localEnv({ GITHUB_MOCK: 'true' }), {
      github: new ApiGitHub(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as InboxDto;
    expect(body.items.map((item) => [item.section, item.number, item.authorTrusted])).toEqual([
      ['question', 72, true],
      ['question', 90001, false],
      ['owner', 21, true],
      ['owner', 46, true],
    ]);
    expect(body.setup).toBe(false);
  });
});
