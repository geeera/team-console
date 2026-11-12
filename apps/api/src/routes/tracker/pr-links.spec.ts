import { env } from 'cloudflare:test';
import type { ItemDto, ItemEventListDto, PrLinkDto } from '@shared/contracts';
import {
  countRows,
  jobActor,
  newKey,
  seedGitHubProject,
  seedItem,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';
import type { TestJob } from '../../testing/local-job-kit';

// #445: `POST …/items/:key/pr-links` (formerly `backlog link-pr`) writes a `pr-linked` item event.

const P = '/api/v1/projects';

interface Seeded {
  readonly project: SeededProject;
  readonly path: string;
  readonly number: number;
  /** A dev job holding the item. */
  readonly dev: TestJob;
  readonly link: { number: number; url: string; headRef: string };
}

async function seed(): Promise<Seeded> {
  const project = await seedTrackerProject();
  const { path, key } = await seedItem(project, { kind: 'feature', status: 'in-progress' });
  const number = Number(key.split('-').at(-1));
  return {
    project,
    path: `${path}/pr-links`,
    number,
    dev: jobActor('dev', 'job-dev-1', [number]),
    link: {
      number: 57,
      url: `https://github.com/acme/${project.slug}/pull/57`,
      headRef: `feature/${key}-login`,
    },
  };
}

async function eventsOf(seeded: Seeded): Promise<ItemEventListDto['events']> {
  const item = seeded.path.replace(/\/pr-links$/, '');
  return ((await (await send('GET', `${item}/events`)).json()) as ItemEventListDto).events;
}

describe('POST /projects/:slug/items/:key/pr-links', () => {
  it('records a pr-linked event under the job, with the server’s URL, and leaves the item as it is', async () => {
    const seeded = await seed();
    const item = seeded.path.replace(/\/pr-links$/, '');
    const before = (await (await send('GET', item)).json()) as ItemDto;
    const response = await send(
      'POST',
      seeded.path,
      { ...seeded.link, url: seeded.link.url.replace('acme', 'ACME') },
      { job: seeded.dev },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const link = (await response.json()) as PrLinkDto;
    expect(link).toEqual({
      ...seeded.link,
      linkedAt: expect.any(String) as unknown,
      linkedBy: { kind: 'job', name: 'dev' },
    });
    expect((await eventsOf(seeded)).at(-1)).toMatchObject({
      kind: 'pr-linked',
      actor: { kind: 'job', name: 'dev' },
      before: null,
      after: seeded.link,
    });
    const row = await env.DB.prepare(
      `SELECT job_id FROM item_events WHERE kind = 'pr-linked' AND item_id = (
         SELECT id FROM items WHERE project_slug = ?1 AND number = ?2)`,
    )
      .bind(seeded.project.slug, seeded.number)
      .first<{ job_id: string }>();
    expect(row?.job_id).toBe('job-dev-1');
    expect(((await (await send('GET', item)).json()) as ItemDto).version).toBe(before.version);
  });

  it('lets the orchestrator link any item of the project', async () => {
    const seeded = await seed();
    const response = await send('POST', seeded.path, seeded.link, { job: jobActor('orchestrator') });
    expect(response.status).toBe(201);
  });

  it('replays the same key, answers a second link of the same PR and branch with the first, 409 on another branch', async () => {
    const seeded = await seed();
    const key = newKey();
    const first = await send('POST', seeded.path, seeded.link, { job: seeded.dev, key });
    const replay = await send('POST', seeded.path, seeded.link, { job: seeded.dev, key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    const firstLink = await first.json();
    expect(await replay.json()).toEqual(firstLink);

    const again = await send('POST', seeded.path, seeded.link, { job: seeded.dev });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstLink);

    const conflict = await send(
      'POST',
      seeded.path,
      { ...seeded.link, headRef: 'feature/other' },
      { job: seeded.dev },
    );
    expect(conflict.status).toBe(409);
    expect(await slugOf(conflict)).toBe('pr-link-conflict');
    expect((await eventsOf(seeded)).filter((event) => event.kind === 'pr-linked')).toHaveLength(1);
  });

  it('403 pr-link-role for a developer that does not hold the item, the owner and the other roles', async () => {
    const seeded = await seed();
    const notHeld = await send('POST', seeded.path, seeded.link, {
      job: jobActor('dev', 'job-dev-2', [999]),
    });
    expect(notHeld.status).toBe(403);
    expect(await slugOf(notHeld)).toBe('pr-link-role');
    expect(await notHeld.json()).toMatchObject({ reason: 'item-not-held' });
    expect(await slugOf(await send('POST', seeded.path, seeded.link))).toBe('pr-link-role');
    for (const role of ['pm', 'qa', 'reviewer', 'security']) {
      const response = await send('POST', seeded.path, seeded.link, {
        job: jobActor(role, 'job-x', [seeded.number]),
      });
      expect(await slugOf(response), role).toBe('pr-link-role');
    }
    expect((await eventsOf(seeded)).filter((event) => event.kind === 'pr-linked')).toHaveLength(0);
  });

  it('401 without identity, 403 for the service, 404 for another project, a missing item or project', async () => {
    const seeded = await seed();
    const other = await seedTrackerProject();
    expect((await sendWithoutIdentity('POST', seeded.path)).status).toBe(401);
    expect(await slugOf(await sendAsService('POST', seeded.path, seeded.link))).toBe('owner-only');
    const foreign = await send('POST', seeded.path, seeded.link, {
      job: { ...seeded.dev, projectSlug: other.slug },
    });
    expect(foreign.status).toBe(404);
    expect(await slugOf(foreign)).toBe('project-not-found');
    const missing = await send('POST', `${P}/${seeded.project.slug}/items/999/pr-links`, seeded.link, {
      job: jobActor('orchestrator'),
    });
    expect(await slugOf(missing)).toBe('item-not-found');
    expect(
      await slugOf(await send('POST', `${P}/nope/items/1/pr-links`, seeded.link, { job: seeded.dev })),
    ).toBe('project-not-found');
  });

  it.each([
    [{ number: 57, headRef: 'feature/x' }, 'url'],
    [{ number: 57, url: 'https://github.com/acme/elsewhere/pull/57', headRef: 'feature/x' }, 'url'],
    [{ number: 57, url: 'https://github.com/acme/x/pull/58', headRef: 'feature/x' }, 'url'],
    [{ number: -1, url: 'https://github.com/acme/x/pull/1', headRef: 'feature/x' }, 'number'],
    [{ headRef: 'feature/x..y' }, 'headRef'],
    [{ headRef: 'feature x' }, 'headRef'],
    [{ headRef: '-delete' }, 'headRef'],
    [{ linkedBy: 'owner' }, 'body'],
    [{ jobId: 'job-forged' }, 'jobId'],
  ])('422 pr-link-invalid on %j (field %s), writing nothing', async (patch, field) => {
    const seeded = await seed();
    const body = 'url' in patch || 'number' in patch ? patch : { ...seeded.link, ...patch };
    const response = await send('POST', seeded.path, body, { job: seeded.dev });
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('pr-link-invalid');
    expect(await response.json()).toMatchObject({ field });
    expect((await eventsOf(seeded)).filter((event) => event.kind === 'pr-linked')).toHaveLength(0);
  });

  it('422 body-secret on a credential-shaped branch name', async () => {
    const seeded = await seed();
    const token = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
    const response = await send(
      'POST',
      seeded.path,
      { ...seeded.link, headRef: `feature/${token}` },
      { job: seeded.dev },
    );
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('body-secret');
  });

  it('409 item-closed on a closed item, 409 tracker-not-cut-over on a GitHub project, 409 for another provider', async () => {
    const seeded = await seed();
    const item = seeded.path.replace(/\/pr-links$/, '');
    expect((await send('PATCH', item, { status: 'done' }, { ifMatch: '"1"' })).status).toBe(200);
    const closed = await send('POST', seeded.path, seeded.link, { job: seeded.dev });
    expect(closed.status).toBe(409);
    expect(await slugOf(closed)).toBe('item-closed');

    const github = await seedGitHubProject();
    const notCutOver = await send('POST', `${P}/${github}/items/1/pr-links`, seeded.link, {
      job: seeded.dev,
    });
    expect(notCutOver.status).toBe(409);
    expect(await slugOf(notCutOver)).toBe('tracker-not-cut-over');

    const gitlab = await seed();
    await env.DB.prepare(`UPDATE projects SET provider = 'gitlab' WHERE slug = ?1`)
      .bind(gitlab.project.slug)
      .run();
    const provider = await send('POST', gitlab.path, gitlab.link, { job: gitlab.dev });
    expect(provider.status).toBe(409);
    expect(await slugOf(provider)).toBe('pr-link-provider');
    expect(await countRows('item_events', gitlab.project.slug)).toBe(1);
  });

  it('413 on a body over the cap', async () => {
    const seeded = await seed();
    const response = await send(
      'POST',
      seeded.path,
      { ...seeded.link, headRef: 'x'.repeat(8192) },
      { job: seeded.dev },
    );
    expect(response.status).toBe(413);
  });
});
