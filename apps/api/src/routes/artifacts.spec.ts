import { env } from 'cloudflare:test';
import { PROBLEM_TYPE_PREFIX, isProblemDetails, type ArtifactsResponse } from '@shared/contracts';
import { MemoryReadCache } from '@worker/github';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
  type StubGitHub,
} from '../testing/github-kit';
import { issue } from '../testing/read-model-kit';

// #19 through the route in workerd: the DTO, the read cache (hit, epoch, fresh), partial answers and subrequests.

const REPO = 'geeera/team-console';
const WEB = `https://github.com/${REPO}`;

function fileAnswer(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return json(200, { type: 'file', encoding: 'base64', size: bytes.byteLength, content: btoa(binary) });
}

function listing(dir: string, names: readonly string[]): Response {
  return json(
    200,
    names.map((name) => {
      const isDir = !name.includes('.');
      return {
        name,
        path: `${dir}/${name}`,
        type: isDir ? 'dir' : 'file',
        html_url: `${WEB}/${isDir ? 'tree' : 'blob'}/dev/${dir}/${name}`,
      };
    }),
  );
}

interface World {
  /** project.yml text; `null` = no such file. */
  readonly projectYml?: string | null;
  readonly decisionCount?: number;
  /** A path prefix that answers 503, to break one reader. */
  readonly failing?: string;
}

const DESIGN_ISSUES = [
  issue(24, ['ux-spec', 'design:approved'], { updated_at: '2026-09-20T00:00:00Z', state: 'closed' }),
  issue(29, ['design:awaiting-approval'], { title: '<b>Commands</b>', updated_at: '2026-09-28T00:00:00Z' }),
];
const DEMO_ISSUES = [issue(70, ['team:demo'], { title: 'Sprint 1 demo', state: 'closed' })];

function handlerFor(world: World): (call: GitHubCall) => Response {
  return (call) => {
    const path = decodeURIComponent(call.url.pathname.replace(`/repos/${REPO}/`, ''));
    if (
      world.failing !== undefined &&
      `${path}?${call.url.searchParams.toString()}`.includes(world.failing)
    ) {
      return json(503, { message: 'unavailable' });
    }
    if (path === 'contents/.product-team/project.yml') {
      return world.projectYml === null
        ? json(404, { message: 'Not Found' })
        : fileAnswer(world.projectYml ?? 'name: x\n');
    }
    if (path === 'contents/docs/decisions') {
      const count = world.decisionCount ?? 2;
      return listing(
        'docs/decisions',
        Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(4, '0')}-adr.md`).concat(
          'README.md',
        ),
      );
    }
    const decision = /^contents\/docs\/decisions\/(\d{4})-adr\.md$/.exec(path);
    if (decision !== null) {
      return fileAnswer(`# Decision ${decision[1]}\n\ntext`);
    }
    if (path === 'contents/docs/design') {
      return listing('docs/design', ['features', 'src', 'references.md']);
    }
    if (path === 'contents/docs/design/features') {
      return listing('docs/design/features', ['24-settings.html', 'board.js']);
    }
    if (path === 'issues') {
      const label = call.url.searchParams.get('labels') ?? '';
      const all = [...DESIGN_ISSUES, ...DEMO_ISSUES];
      return json(
        200,
        all.filter((item) => (item['labels'] as { name: string }[]).some((entry) => entry.name === label)),
      );
    }
    return json(404, { message: 'Not Found' });
  };
}

function setup(world: World = {}): { github: ApiGitHub; stub: StubGitHub } {
  const stub = stubGitHub(handlerFor(world));
  return {
    stub,
    github: new ApiGitHub({
      fetch: stub.fetch,
      readCache: new MemoryReadCache(),
      now: () => Date.parse('2026-10-04T10:00:00Z'),
    }),
  };
}

async function artifacts(github: ApiGitHub, query = ''): Promise<Response> {
  return fetchApi(`/api/v1/projects/tc/artifacts${query}`, localEnv(), { github });
}

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', REPO);
});

describe('GET /api/v1/projects/:slug/artifacts', () => {
  it('lists decisions, designs and demos with github.com links, titles as plain text', async () => {
    const { github, stub } = setup();
    const response = await artifacts(github);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ArtifactsResponse;
    expect(body).toEqual({
      loadedAt: '2026-10-04T10:00:00.000Z',
      items: [
        {
          type: 'decision',
          title: 'Decision 0002',
          url: `${WEB}/blob/dev/docs/decisions/0002-adr.md`,
          updatedAt: null,
          source: 'file',
          state: null,
        },
        {
          type: 'decision',
          title: 'Decision 0001',
          url: `${WEB}/blob/dev/docs/decisions/0001-adr.md`,
          updatedAt: null,
          source: 'file',
          state: null,
        },
        {
          type: 'design',
          title: '<b>Commands</b>',
          url: `${WEB}/issues/29`,
          updatedAt: '2026-09-28T00:00:00Z',
          source: 'issue',
          state: 'open',
        },
        {
          type: 'design',
          title: 'Issue 24',
          url: `${WEB}/issues/24`,
          updatedAt: '2026-09-20T00:00:00Z',
          source: 'issue',
          state: 'closed',
        },
        {
          type: 'design',
          title: 'features/24-settings.html',
          url: `${WEB}/blob/dev/docs/design/features/24-settings.html`,
          updatedAt: null,
          source: 'file',
          state: null,
        },
        {
          type: 'design',
          title: 'references.md',
          url: `${WEB}/blob/dev/docs/design/references.md`,
          updatedAt: null,
          source: 'file',
          state: null,
        },
        {
          type: 'demo',
          title: 'Sprint 1 demo',
          url: `${WEB}/issues/70`,
          updatedAt: null,
          source: 'issue',
          state: 'closed',
        },
      ],
    });
    // lookup + mint + project.yml + decisions listing + 2 titles + 3 design labels + docs/design + features + demo
    expect(stub.calls).toHaveLength(12);
  });

  it('answers a second request within the TTL from the read cache', async () => {
    const { github, stub } = setup();
    await artifacts(github);
    const before = stub.reads().length;

    const again = await artifacts(github);

    expect(again.status).toBe(200);
    expect(stub.reads()).toHaveLength(before);
  });

  it('fills again after an epoch bump (#12 webhooks)', async () => {
    const { github, stub } = setup();
    await artifacts(github);
    const before = stub.reads().length;

    await env.DB.prepare('UPDATE projects SET cache_epoch = cache_epoch + 1 WHERE slug = ?1')
      .bind('tc')
      .run();
    await artifacts(github);

    // Every artifact read again; project.yml too, as its key carries the epoch as well.
    expect(stub.reads().length - before).toBe(before);
  });

  it('fills again with fresh=1 ("Check again") but leaves project.yml to its own TTL', async () => {
    const { github, stub } = setup();
    await artifacts(github);
    const before = stub.reads().length;

    await artifacts(github, '?fresh=1');

    expect(stub.reads().length - before).toBe(before - 1);
  });

  it('reports a failing type in partial and still answers the others', async () => {
    const { github } = setup({ failing: 'labels=team%3Ademo' });
    const response = await artifacts(github);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ArtifactsResponse;
    expect(body.partial).toEqual(['demo']);
    expect(body.items.some((item) => item.type === 'demo')).toBe(false);
    expect(body.items.some((item) => item.type === 'decision')).toBe(true);
  });

  it('lists decisions past 30 by file name and says so in partial', async () => {
    const { github, stub } = setup({ decisionCount: 33 });
    const body = (await (await artifacts(github)).json()) as ArtifactsResponse;

    const decisions = body.items.filter((item) => item.type === 'decision');
    expect(decisions).toHaveLength(33);
    expect(decisions.filter((item) => item.title.startsWith('Decision '))).toHaveLength(30);
    expect(body.partial).toEqual(['decision-titles']);
    expect(stub.calls.length).toBeLessThanOrEqual(50);
  });

  it('reads a missing decisions folder (404) as no decisions, and an unusable decisions_dir as partial', async () => {
    const missing = setup({ projectYml: 'decisions_dir: docs/adr\n' });
    const empty = (await (await artifacts(missing.github)).json()) as ArtifactsResponse;
    expect(empty.partial).toBeUndefined();
    expect(empty.items.some((item) => item.type === 'decision')).toBe(false);

    const unusable = setup({ projectYml: 'decisions_dir: ../../x\n' });
    const body = (await (await artifacts(unusable.github)).json()) as ArtifactsResponse;
    expect(body.partial).toEqual(['decision']);
    expect(unusable.stub.reads().some((call) => call.url.pathname.includes('..'))).toBe(false);
  });

  it('reads docs/decisions when the repository has no project.yml', async () => {
    const { github } = setup({ projectYml: null });
    const body = (await (await artifacts(github)).json()) as ArtifactsResponse;

    expect(body.partial).toBeUndefined();
    expect(body.items.filter((item) => item.type === 'decision')).toHaveLength(2);
  });

  it('answers the GitHub problem (502 for a GitHub 503) when every type fails', async () => {
    const { github } = setup({ failing: '' });
    const response = await artifacts(github);

    expect(response.status).toBe(502);
    const body: unknown = await response.json();
    expect(isProblemDetails(body) && body.type.startsWith(PROBLEM_TYPE_PREFIX)).toBe(true);
  });

  it('is a 404 project-not-found for an unknown or malformed slug, before GitHub is asked', async () => {
    const { github, stub } = setup();
    const response = await fetchApi('/api/v1/projects/nope/artifacts', localEnv(), { github });
    const traversal = await fetchApi('/api/v1/projects/..%2Fx/artifacts', localEnv(), { github });

    expect(response.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });
});
