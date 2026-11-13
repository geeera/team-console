import { env } from 'cloudflare:test';
import { addDays, type ItemDto, type TrackerSprintDto } from '@shared/contracts';
import { sprintToday } from '@worker/read-models';
import { ApiGitHub } from '../../github';
import { json, stubGitHub } from '../../testing/github-kit';
import { readModelGitHub } from '../../testing/read-model-kit';
import { countRows, send, seedTrackerProject, slugOf, type SeededProject } from '../../testing/tracker-kit';

// #556: the server refuses a move into a sprint during its freeze; the console's hint is not the only guard.

const itemsPath = (slug: string): string => `/api/v1/projects/${slug}/items`;

function githubWith(slug: string, projectYml: string): ApiGitHub {
  return new ApiGitHub({ fetch: stubGitHub(readModelGitHub({ [`acme/${slug}`]: { projectYml } })).fetch });
}

/** A sprint whose demo is `days` from today (Kyiv, as the plugin counts). */
async function sprintDueIn(project: SeededProject, days: number): Promise<TrackerSprintDto> {
  const dueOn = addDays(sprintToday(Date.now()), days);
  const response = await send('POST', `/api/v1/projects/${project.slug}/sprints`, { dueOn });
  expect(response.status).toBe(201);
  return (await response.json()) as TrackerSprintDto;
}

async function itemIn(project: SeededProject, sprint: number | null): Promise<ItemDto> {
  const response = await send('POST', itemsPath(project.slug), { title: 'Item', kind: 'feature', sprint });
  expect(response.status).toBe(201);
  return (await response.json()) as ItemDto;
}

function create(project: SeededProject, sprint: number | null, github?: ApiGitHub): Promise<Response> {
  return send('POST', itemsPath(project.slug), { title: 'Item', kind: 'feature', sprint }, { github });
}

/**
 * Plants an item already in `sprint`, as if it had been planned before the sprint's freeze started — the only
 * way #556's PATCH "move out" case has data to exercise, now that #560 refuses a *creation* into a frozen sprint.
 */
async function itemPlantedIn(project: SeededProject, sprint: TrackerSprintDto): Promise<ItemDto> {
  const item = await itemIn(project, null);
  await env.DB.prepare(
    `UPDATE items SET sprint_id = (SELECT id FROM sprints WHERE project_slug = ?1 AND number = ?2)
     WHERE project_slug = ?1 AND number = ?3`,
  )
    .bind(project.slug, sprint.number, item.number)
    .run();
  return { ...item, sprint: sprint.number };
}

function move(project: SeededProject, item: ItemDto, sprint: number | null, github: ApiGitHub): Promise<Response> {
  return send(
    'PATCH',
    `${itemsPath(project.slug)}/${item.key}`,
    { sprint },
    { ifMatch: `"${String(item.version)}"`, github },
  );
}

describe('PATCH /projects/:slug/items/:key {sprint} and the freeze (#556)', () => {
  it('refuses a move into a sprint in its freeze with 409 sprint-frozen, changing nothing', async () => {
    const project = await seedTrackerProject();
    const frozen = await sprintDueIn(project, 2);
    const item = await itemIn(project, null);
    const events = await countRows('item_events', project.slug);

    const response = await move(project, item, frozen.number, githubWith(project.slug, 'sprint:\n  freeze_days: 3\n'));

    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('sprint-frozen');
    const after = (await (await send('GET', `${itemsPath(project.slug)}/${item.key}`)).json()) as ItemDto;
    expect(after).toMatchObject({ sprint: null, version: item.version });
    expect(await countRows('item_events', project.slug)).toBe(events);
  });

  it('moves into a sprint whose freeze has not started, by the project’s freeze_days', async () => {
    const project = await seedTrackerProject();
    const sprint = await sprintDueIn(project, 2);
    const item = await itemIn(project, null);

    const response = await move(project, item, sprint.number, githubWith(project.slug, 'sprint:\n  freeze_days: 1\n'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sprint: sprint.number, version: item.version + 1 });
  });

  it('still moves an item out of a frozen sprint, to the backlog or to a later sprint', async () => {
    const project = await seedTrackerProject();
    const frozen = await sprintDueIn(project, 1);
    const later = await sprintDueIn(project, 30);
    const github = githubWith(project.slug, 'sprint:\n  freeze_days: 2\n');

    const toBacklog = await move(project, await itemPlantedIn(project, frozen), null, github);
    const toLater = await move(project, await itemPlantedIn(project, frozen), later.number, github);

    expect(toBacklog.status).toBe(200);
    expect(await toBacklog.json()).toMatchObject({ sprint: null });
    expect(toLater.status).toBe(200);
    expect(await toLater.json()).toMatchObject({ sprint: later.number });
  });

  it('judges with the plugin’s default freeze when GitHub cannot be read', async () => {
    const project = await seedTrackerProject();
    const frozen = await sprintDueIn(project, 1);
    const outage = new ApiGitHub({ fetch: stubGitHub(() => json(500, { message: 'boom' })).fetch });

    const response = await move(project, await itemIn(project, null), frozen.number, outage);

    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('sprint-frozen');
  });
});

// #560: creation must refuse the same freeze the PATCH move does (#556), through the shared `frozenSprintRefusal`.
describe('POST /projects/:slug/items {sprint} and the freeze (#560)', () => {
  it('refuses creation into a sprint in its freeze with 409 sprint-frozen, writing nothing', async () => {
    const project = await seedTrackerProject();
    const frozen = await sprintDueIn(project, 2);
    const items = await countRows('items', project.slug);
    const events = await countRows('item_events', project.slug);

    const response = await create(project, frozen.number, githubWith(project.slug, 'sprint:\n  freeze_days: 3\n'));

    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('sprint-frozen');
    expect(await countRows('items', project.slug)).toBe(items);
    expect(await countRows('item_events', project.slug)).toBe(events);
  });

  it('still creates into a sprint whose freeze has not started', async () => {
    const project = await seedTrackerProject();
    const sprint = await sprintDueIn(project, 2);

    const response = await create(project, sprint.number, githubWith(project.slug, 'sprint:\n  freeze_days: 1\n'));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sprint: sprint.number });
  });

  it('is unaffected when the new item names no sprint', async () => {
    const project = await seedTrackerProject();

    const response = await create(project, null);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sprint: null });
  });
});
