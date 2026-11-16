import type { PullRequestItemsDto } from '@shared/contracts';
import {
  jobActor,
  seedItem,
  seedPrLink,
  seedTrackerProject,
  send,
  slugOf,
  type SeededProject,
} from '../testing/tracker-kit';

// #627: `GET …/prs/:number/items` — the items `pr-linked` events link to a pull request, for the plugin's merge gate.
// Who reaches the row at all is proven cell by cell in `tracker-matrix.spec.ts`; this spec is the route's own rules.

const pathOf = (project: SeededProject, number: number | string, query = ''): string =>
  `/api/v1/projects/${project.slug}/prs/${String(number)}/items${query}`;

async function readAs(path: string, role = 'dev'): Promise<Response> {
  return send('GET', path, undefined, { job: jobActor(role) });
}

describe('GET /api/v1/projects/:slug/prs/:number/items', () => {
  it('lists the items linked to the pull request with their labels, closed ones included, and the project’s repository', async () => {
    const project = await seedTrackerProject();
    const secure = await seedItem(project, {
      title: 'Login',
      kind: 'feature',
      status: 'in-progress',
      labels: ['security'],
    });
    const closed = await seedItem(project, { title: 'Logout', kind: 'bug', status: 'qa' });
    const elsewhere = await seedItem(project, { title: 'Export', kind: 'feature', status: 'in-progress' });
    await seedPrLink(project, secure.key, 57);
    await seedPrLink(project, closed.key, 57);
    await seedPrLink(project, elsewhere.key, 58);
    expect((await send('PATCH', closed.path, { status: 'done' }, { ifMatch: '"1"' })).status).toBe(200);

    const response = await readAs(pathOf(project, 57));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as PullRequestItemsDto;
    expect(body).toMatchObject({ number: 57, provider: 'github', repo: `acme/${project.slug}`, next: null });
    expect(body.items.map((item) => [item.key, item.state, item.labels])).toEqual([
      [secure.key, 'open', ['status:in-progress', 'kind:feature', 'security']],
      [closed.key, 'closed', ['status:done', 'kind:bug']],
    ]);
  });

  it('answers an empty page for a pull request linked to nothing, whether or not the mirror has it', async () => {
    const project = await seedTrackerProject();
    const { key } = await seedItem(project, { kind: 'feature', status: 'in-progress' });
    await seedPrLink(project, key, 57);
    const response = await readAs(pathOf(project, 99));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      number: 99,
      provider: 'github',
      repo: `acme/${project.slug}`,
      items: [],
      next: null,
    });
  });

  it('never reads another project’s links to the same number', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    const { key } = await seedItem(other, { kind: 'feature', status: 'in-progress' });
    await seedPrLink(other, key, 57);
    const body = (await (await readAs(pathOf(project, 57))).json()) as PullRequestItemsDto;
    expect(body.items).toEqual([]);
  });

  it('pages in queue order with ?after= and ?limit=', async () => {
    const project = await seedTrackerProject();
    const first = await seedItem(project, { kind: 'feature', status: 'in-progress' });
    const second = await seedItem(project, { kind: 'feature', status: 'in-progress' });
    await seedPrLink(project, first.key, 57);
    await seedPrLink(project, second.key, 57);
    const page = (await (await readAs(pathOf(project, 57, '?limit=1'))).json()) as PullRequestItemsDto;
    expect(page.items.map((item) => item.key)).toEqual([first.key]);
    expect(page.next).toBe(page.items[0]?.number);
    const rest = (await (
      await readAs(pathOf(project, 57, `?limit=1&after=${String(page.next)}`))
    ).json()) as PullRequestItemsDto;
    expect(rest.items.map((item) => item.key)).toEqual([second.key]);
    expect(rest.next).toBeNull();
  });

  it('is read by every actor of the project, the owner included', async () => {
    const project = await seedTrackerProject();
    for (const role of ['orchestrator', 'qa', 'security', 'reviewer']) {
      expect((await readAs(pathOf(project, 57), role)).status, role).toBe(200);
    }
    expect((await send('GET', pathOf(project, 57))).status).toBe(200);
  });

  it.each([
    ['not a number', 'abc', '', 'pull-request-number'],
    ['zero', '0', '', 'pull-request-number'],
    ['a bad limit', '57', '?limit=0', 'query-invalid'],
    ['a bad cursor', '57', '?after=x', 'query-invalid'],
  ])('answers 400 to %s', async (_, number, query, slug) => {
    const project = await seedTrackerProject();
    const response = await readAs(pathOf(project, number, query));
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe(slug);
  });
});
