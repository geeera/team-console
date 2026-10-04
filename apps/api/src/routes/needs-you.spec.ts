import { env } from 'cloudflare:test';
import { NEEDS_YOU_MAX_PROJECTS, type NeedsYouDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { json, localEnv, resetProjects, seedProject, stubGitHub } from '../testing/github-kit';
import { issue, readModelGitHub, type RepoState } from '../testing/read-model-kit';

// #35 / #9 threat row 8: the cross-project fan-out, its cap and its subrequest count.

const PATH = '/api/v1/needs-you';

async function seed(count: number): Promise<Record<string, RepoState>> {
  const repos: Record<string, RepoState> = {};
  for (let i = 1; i <= count; i += 1) {
    const slug = `p${String(i).padStart(2, '0')}`;
    await env.DB.prepare(
      'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES (?1, ?2, ?3, 0, ?4)',
    )
      .bind(slug, `geeera/${slug}`, `Project ${i}`, `2026-09-30T00:00:${String(i).padStart(2, '0')}Z`)
      .run();
    repos[`geeera/${slug}`] = {
      issues: [issue(i, ['kind:question']), issue(100 + i, ['needs:owner', 'kind:chore'])],
    };
  }
  return repos;
}

beforeEach(async () => {
  await resetProjects();
});

describe('GET /api/v1/needs-you', () => {
  it('merges the projects: inbox order, then registry order, each item tagged with its project', async () => {
    const stub = stubGitHub(readModelGitHub(await seed(2)));
    const response = await fetchApi(PATH, localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as NeedsYouDto;
    expect(body.items.map((item) => `${item.section}:${item.project.slug}#${item.number}`)).toEqual([
      'question:p01#1',
      'question:p02#2',
      'owner:p01#101',
      'owner:p02#102',
    ]);
    expect(body.items[0]).toMatchObject({
      project: { slug: 'p01', name: 'Project 1' },
      allowedCommands: ['approve', 'reject'],
    });
    expect(body.projects.map((p) => [p.slug, p.problem])).toEqual([
      ['p01', null],
      ['p02', null],
    ]);
    expect(body.omittedProjects).toEqual([]);
  });

  it(`reads at most ${NEEDS_YOU_MAX_PROJECTS} projects and stays within the subrequest budget`, async () => {
    const stub = stubGitHub(readModelGitHub(await seed(NEEDS_YOU_MAX_PROJECTS + 2)));
    const response = await fetchApi(PATH, localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) });
    const body = (await response.json()) as NeedsYouDto;

    expect(body.projects).toHaveLength(NEEDS_YOU_MAX_PROJECTS);
    expect(body.omittedProjects.map((p) => p.slug)).toEqual(['p07', 'p08']);
    // Per project on a cold isolate: installation lookup, mint, open issues (1 page), project.yml.
    expect(stub.calls).toHaveLength(NEEDS_YOU_MAX_PROJECTS * 4);
    expect(new Set(stub.reads().map((call) => call.url.pathname.split('/')[3]))).toEqual(
      new Set(['p01', 'p02', 'p03', 'p04', 'p05', 'p06']),
    );
  });

  it('uses the per-project read cache: a second request makes no subrequest', async () => {
    const stub = stubGitHub(readModelGitHub(await seed(3)));
    const github = new ApiGitHub({ fetch: stub.fetch });
    await fetchApi(PATH, localEnv(), { github });
    const before = stub.calls.length;
    await fetchApi(PATH, localEnv(), { github });
    await fetchApi('/api/v1/projects/p01/inbox', localEnv(), { github });
    expect(stub.calls).toHaveLength(before);
  });

  it('reports a project that cannot be read and still lists the others', async () => {
    const repos = await seed(2);
    await seedProject('broken', 'geeera/broken');
    const stub = stubGitHub(readModelGitHub(repos), undefined);
    const notInstalled = stubGitHub(readModelGitHub(repos), () => json(404, {}));
    const github = new ApiGitHub({
      fetch: async (input, init) =>
        input.includes('/repos/geeera/broken/') ? notInstalled.fetch(input, init) : stub.fetch(input, init),
    });
    const response = await fetchApi(PATH, localEnv(), { github });
    expect(response.status).toBe(200);
    const body = (await response.json()) as NeedsYouDto;
    expect(body.items).toHaveLength(4);
    expect(body.projects.find((p) => p.slug === 'broken')?.problem).toEqual({
      type: 'github-app-not-installed',
      title: 'The console app is not installed on this repository',
      status: 409,
    });
  });

  it('reports an unusable project.yml per project', async () => {
    const repos = await seed(2);
    repos['geeera/p02'] = { ...repos['geeera/p02'], projectYml: 'a: &a [x]\nb: *a\n' };
    const stub = stubGitHub(readModelGitHub(repos));
    const body = (await (
      await fetchApi(PATH, localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) })
    ).json()) as NeedsYouDto;
    expect(body.projects.map((p) => p.problem?.type ?? null)).toEqual([null, 'project-config-invalid']);
    expect(body.items.every((item) => item.project.slug === 'p01')).toBe(true);
  });

  it('surfaces a rate limit on any project as 429 with the longest Retry-After', async () => {
    const repos = await seed(3);
    const ok = readModelGitHub(repos);
    const stub = stubGitHub((call) => {
      if (call.url.pathname.startsWith('/repos/geeera/p02/')) {
        return json(403, {}, { 'x-ratelimit-remaining': '0', 'retry-after': '30' });
      }
      if (call.url.pathname.startsWith('/repos/geeera/p03/')) {
        return json(429, {}, { 'retry-after': '90' });
      }
      return ok(call);
    });
    const response = await fetchApi(PATH, localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('90');
  });

  it('with no projects answers an empty list', async () => {
    const stub = stubGitHub(() => json(500, {}));
    const response = await fetchApi(PATH, localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) });
    await expect(response.json()).resolves.toEqual({ items: [], projects: [], omittedProjects: [] });
    expect(stub.calls).toHaveLength(0);
  });
});
