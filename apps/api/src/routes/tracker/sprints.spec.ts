import type { TrackerSprintDto, TrackerSprintListDto } from '@shared/contracts';
import { SprintsRepo } from '@worker/db';
import {
  countRows,
  newKey,
  seedGitHubProject,
  seedItem,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
} from '../../testing/tracker-kit';

// #410: sprints of the console's own tracker, numbered per project.

const sprintsPath = (slug: string): string => `/api/v1/projects/${slug}/sprints`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:slug/sprints', () => {
  it('creates the next sprint as Sprint NN', async () => {
    const project = await seedTrackerProject();
    const first = await send('POST', sprintsPath(project.slug), {
      dueOn: '2026-11-17',
      description: 'Tracker core',
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('Location')).toBe(`${sprintsPath(project.slug)}/1`);
    expect(await first.json()).toMatchObject({
      number: 1,
      title: 'Sprint 01',
      dueOn: '2026-11-17',
      state: 'open',
      description: 'Tracker core',
      closedAt: null,
    });
    const second = (await (await send('POST', sprintsPath(project.slug), {})).json()) as TrackerSprintDto;
    expect(second).toMatchObject({ number: 2, title: 'Sprint 02', dueOn: null });
  });

  it('answers a replayed key with the first sprint and creates no second one', async () => {
    const project = await seedTrackerProject();
    const key = newKey();
    const first = await send('POST', sprintsPath(project.slug), { dueOn: '2026-11-17' }, { key });
    const again = await send('POST', sprintsPath(project.slug), { dueOn: '2026-11-17' }, { key });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('sprints', project.slug)).toBe(1);
  });

  it("names the sprint with the owner's title, cleaned to one line of plain text (#457)", async () => {
    const project = await seedTrackerProject();
    const named = await send('POST', sprintsPath(project.slug), {
      dueOn: '2026-11-17',
      title: '  \u202eCheckout\u200b\n  polish ',
    });
    expect(named.status).toBe(201);
    expect(await named.json()).toMatchObject({ number: 1, title: 'Checkout polish' });
    const unnamed = await send('POST', sprintsPath(project.slug), { title: null });
    expect(await unnamed.json()).toMatchObject({ number: 2, title: 'Sprint 02' });
  });

  it('accepts a title of 256 characters', async () => {
    const project = await seedTrackerProject();
    const response = await send('POST', sprintsPath(project.slug), { title: 'x'.repeat(256) });
    expect(response.status).toBe(201);
  });

  it('answers 422 for a title another sprint has, ignoring case, and writes nothing', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), { title: 'Checkout' });
    const response = await send('POST', sprintsPath(project.slug), { title: ' checkout ' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('sprint-invalid'),
      field: 'title',
    });
    expect(await countRows('sprints', project.slug)).toBe(1);
  });

  it('answers 422 for a title equal to a default name already taken', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), {});
    const response = await send('POST', sprintsPath(project.slug), { title: 'Sprint 01' });
    expect(response.status).toBe(422);
  });

  it('answers 422 for a Cyrillic title in another case', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), { title: 'Спринт Альфа' });
    const response = await send('POST', sprintsPath(project.slug), { title: 'СПРИНТ альфа' });
    expect(response.status).toBe(422);
    expect(await countRows('sprints', project.slug)).toBe(1);
  });

  // #554: the default name skips titles the owner already entered.
  it('creates a sprint without a title as the next free Sprint NN when the default is taken', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), { title: 'sprint 02' });
    const response = await send('POST', sprintsPath(project.slug), {});
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ number: 2, title: 'Sprint 03' });
    expect(await countRows('sprints', project.slug)).toBe(2);
  });

  // #545: two creates of one name that both passed the check; the unique index refuses the second.
  it('answers the same 422 when the unique index refuses a title the check missed, and writes nothing', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), { title: 'Checkout' });
    vi.spyOn(SprintsRepo.prototype, 'findByTitle').mockResolvedValue(null);
    const response = await send('POST', sprintsPath(project.slug), { title: 'checkout' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('sprint-invalid'),
      field: 'title',
      detail: 'A sprint with this title already exists',
    });
    expect(await countRows('sprints', project.slug)).toBe(1);
  });

  it.each([
    [{ dueOn: '17.11.2026' }, 'dueOn'],
    [{ dueOn: '2026-02-30' }, 'dueOn'],
    [{ title: '   ' }, 'title'],
    [{ title: '\u200b\u202e' }, 'title'],
    [{ title: 'x'.repeat(257) }, 'title'],
    [{ title: 7 }, 'title'],
    [{ name: 'Sprint 99' }, 'body'],
  ])('answers 422 sprint-invalid for %j', async (body, field) => {
    const project = await seedTrackerProject();
    const response = await send('POST', sprintsPath(project.slug), body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('sprint-invalid'), field });
  });

  it('answers 409 tracker-not-cut-over and 404 for an unknown project', async () => {
    const gated = await send('POST', sprintsPath(await seedGitHubProject()), {});
    expect(gated.status).toBe(409);
    expect(await slugOf(gated)).toBe('tracker-not-cut-over');
    expect((await send('POST', sprintsPath('nope'), {})).status).toBe(404);
  });
});

describe('PATCH /projects/:slug/sprints/:number', () => {
  it('moves the demo day, closes and reopens the sprint', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), { dueOn: '2026-11-17' });
    const path = `${sprintsPath(project.slug)}/1`;
    const moved = await send('PATCH', path, { dueOn: '2026-11-19' });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ dueOn: '2026-11-19', state: 'open' });
    const closed = (await (await send('PATCH', path, { state: 'closed' })).json()) as TrackerSprintDto;
    expect(closed.state).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(await (await send('PATCH', path, { state: 'open' })).json()).toMatchObject({
      state: 'open',
      closedAt: null,
    });
  });

  it('answers 404 sprint-not-found for an unknown or malformed number, 422 for a bad change', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), {});
    for (const number of ['9', 'x', '0']) {
      const response = await send('PATCH', `${sprintsPath(project.slug)}/${number}`, { state: 'closed' });
      expect(response.status).toBe(404);
      expect(await slugOf(response)).toBe('sprint-not-found');
    }
    const invalid = await send('PATCH', `${sprintsPath(project.slug)}/1`, { state: 'done' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ field: 'state' });
  });

  it('refuses planning an item into a closed sprint', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), {});
    await send('PATCH', `${sprintsPath(project.slug)}/1`, { state: 'closed' });
    const response = await send('POST', `/api/v1/projects/${project.slug}/items`, {
      title: 'T',
      kind: 'bug',
      sprint: 1,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: 'sprint' });
  });
});

describe('GET /projects/:slug/sprints[/:number]', () => {
  it('lists sprints in number order, filtered by state, and reads one', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), {});
    await send('POST', sprintsPath(project.slug), {});
    await send('PATCH', `${sprintsPath(project.slug)}/1`, { state: 'closed' });
    const all = (await (await send('GET', sprintsPath(project.slug))).json()) as TrackerSprintListDto;
    expect(all.sprints.map((sprint) => sprint.number)).toEqual([1, 2]);
    const open = (await (
      await send('GET', `${sprintsPath(project.slug)}?state=open`)
    ).json()) as TrackerSprintListDto;
    expect(open.sprints.map((sprint) => sprint.number)).toEqual([2]);
    expect((await send('GET', `${sprintsPath(project.slug)}?state=done`)).status).toBe(400);
    expect(await (await send('GET', `${sprintsPath(project.slug)}/2`)).json()).toMatchObject({
      title: 'Sprint 02',
    });
    expect((await send('GET', `${sprintsPath(project.slug)}/3`)).status).toBe(404);
  });
});

describe('open item counts', () => {
  const listOf = async (slug: string): Promise<TrackerSprintListDto> =>
    (await (await send('GET', sprintsPath(slug))).json()) as TrackerSprintListDto;

  it('counts open items per sprint, zero included, and the open backlog', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), {});
    await send('POST', sprintsPath(project.slug), {});
    await send('POST', sprintsPath(project.slug), {});
    await seedItem(project, { sprint: 1 });
    await seedItem(project, { sprint: 1 });
    await seedItem(project, { sprint: 2 });
    await seedItem(project);
    await seedItem(project);
    await seedItem(project);

    const list = await listOf(project.slug);
    expect(list.sprints.map((sprint) => [sprint.number, sprint.openCount])).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
    ]);
    expect(list.backlogOpenCount).toBe(3);
    expect(await (await send('GET', `${sprintsPath(project.slug)}/1`)).json()).toMatchObject({ openCount: 2 });
    expect(await (await send('GET', `${sprintsPath(project.slug)}/3`)).json()).toMatchObject({ openCount: 0 });
  });

  it('leaves closed items out of both counts', async () => {
    const project = await seedTrackerProject();
    await send('POST', sprintsPath(project.slug), {});
    const planned = await seedItem(project, { sprint: 1 });
    await seedItem(project, { sprint: 1 });
    const backlog = await seedItem(project);
    await seedItem(project);
    for (const item of [planned, backlog]) {
      const closed = await send('PATCH', item.path, { status: 'done' }, { ifMatch: '"1"' });
      expect(closed.status).toBe(200);
    }

    const list = await listOf(project.slug);
    expect(list.sprints[0]?.openCount).toBe(1);
    expect(list.backlogOpenCount).toBe(1);
  });

  it('counts only the project’s own items', async () => {
    const mine = await seedTrackerProject();
    const other = await seedTrackerProject();
    await send('POST', sprintsPath(mine.slug), {});
    await send('POST', sprintsPath(other.slug), {});
    await seedItem(mine, { sprint: 1 });
    await seedItem(other, { sprint: 1 });
    await seedItem(other, { sprint: 1 });
    await seedItem(other);

    const list = await listOf(mine.slug);
    expect(list.sprints[0]?.openCount).toBe(1);
    expect(list.backlogOpenCount).toBe(0);
  });

  it('answers zero counts for a project without items', async () => {
    const project = await seedTrackerProject();
    expect(await listOf(project.slug)).toEqual({ sprints: [], backlogOpenCount: 0 });
  });
});

describe('the sprint routes are the owner’s', () => {
  it.each([
    ['GET', ''],
    ['POST', ''],
    ['GET', '/1'],
    ['PATCH', '/1'],
  ])(
    '%s %s answers 401 without an identity and 403 owner-only to the service identity',
    async (method, route) => {
      const project = await seedTrackerProject();
      await send('POST', sprintsPath(project.slug), {});
      const path = `${sprintsPath(project.slug)}${route}`;
      expect((await sendWithoutIdentity(method, path)).status).toBe(401);
      const service = await sendAsService(method, path, { state: 'closed' });
      expect(service.status).toBe(403);
      expect(await slugOf(service)).toBe('owner-only');
      expect(await (await send('GET', `${sprintsPath(project.slug)}/1`)).json()).toMatchObject({
        state: 'open',
      });
    },
  );
});
