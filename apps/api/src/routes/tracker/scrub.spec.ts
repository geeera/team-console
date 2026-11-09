import type { ItemEventDto, ItemEventListDto } from '@shared/contracts';
import {
  countRows,
  jobActor,
  newKey,
  seedTrackerProject,
  send,
  sendAsService,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #462 (ADR 0008 row 2-0, #446 decision 5): the owner's scrub of an item's history — incident response for a secret
// that reached a title or body. Masks title/body in the item's created and edited events, records a `scrubbed` event.

const P = '/api/v1/projects';
const LEAK = ['gh', 'p_', 'Z9y8'.repeat(9)].join('');

async function leakedItem(project: SeededProject): Promise<string> {
  const created = await send('POST', `${P}/${project.slug}/items`, {
    title: `Deploy with ${LEAK}`,
    kind: 'chore',
    body: `The token is ${LEAK}`,
    tier: 'light',
  });
  expect(created.status).toBe(201);
  const path = `${P}/${project.slug}/items/${project.keyPrefix}-1`;
  const corrected = await send(
    'PATCH',
    path,
    { title: 'Deploy', body: 'Rotated.', tier: 'heavy' },
    { ifMatch: '"1"' },
  );
  expect(corrected.status).toBe(200);
  return path;
}

async function eventsOf(path: string): Promise<readonly ItemEventDto[]> {
  return ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
}

describe('POST /projects/:slug/items/:key/events/scrub', () => {
  it('masks title and body in the created and edited events, keeps the rest, and records a scrubbed event', async () => {
    const project = await seedTrackerProject();
    const path = await leakedItem(project);
    expect(JSON.stringify(await eventsOf(path))).toContain(LEAK);

    const response = await send('POST', `${path}/events/scrub`, {});
    expect(response.status).toBe(201);
    const scrub = (await response.json()) as ItemEventDto;
    expect(scrub).toMatchObject({
      kind: 'scrubbed',
      actor: { kind: 'owner' },
      before: null,
      after: { events: 2, fields: ['title', 'body'] },
    });

    const events = await eventsOf(path);
    expect(JSON.stringify(events)).not.toContain(LEAK);
    expect(events.map((event) => event.kind)).toEqual(['created', 'edited', 'scrubbed']);
    expect(events[0]).toMatchObject({
      before: null,
      after: { title: '[scrubbed]', kind: 'chore', tier: 'light' },
    });
    expect(events[1]).toMatchObject({
      before: { title: '[scrubbed]', body: '[scrubbed]', tier: 'light' },
      after: { title: '[scrubbed]', body: '[scrubbed]', tier: 'heavy' },
    });
    // The item itself is the owner's correction, untouched by the scrub.
    expect(await (await send('GET', path)).json()).toMatchObject({
      title: 'Deploy',
      body: 'Rotated.',
      version: 2,
    });
  });

  it('answers a replayed key with the same scrubbed event and writes no second one', async () => {
    const project = await seedTrackerProject();
    const path = await leakedItem(project);
    const key = newKey();
    const first = (await (await send('POST', `${path}/events/scrub`, {}, { key })).json()) as ItemEventDto;
    const again = await send('POST', `${path}/events/scrub`, {}, { key });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(((await again.json()) as ItemEventDto).id).toBe(first.id);
    expect((await eventsOf(path)).filter((event) => event.kind === 'scrubbed')).toHaveLength(1);
  });

  it('records a second scrub that has nothing left to mask', async () => {
    const project = await seedTrackerProject();
    const path = await leakedItem(project);
    expect((await send('POST', `${path}/events/scrub`)).status).toBe(201);
    const second = await send('POST', `${path}/events/scrub`);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ kind: 'scrubbed', after: { events: 0 } });
  });

  it('leaves other items’ events alone', async () => {
    const project = await seedTrackerProject();
    const path = await leakedItem(project);
    const other = await send('POST', `${P}/${project.slug}/items`, { title: 'Other', kind: 'chore' });
    expect(other.status).toBe(201);
    expect((await send('POST', `${path}/events/scrub`)).status).toBe(201);
    const otherEvents = await eventsOf(`${P}/${project.slug}/items/${project.keyPrefix}-2`);
    expect(otherEvents).toMatchObject([{ kind: 'created', after: { title: 'Other' } }]);
  });

  it('answers 422 for a body with members, 400 without an Idempotency-Key, writing nothing', async () => {
    const project = await seedTrackerProject();
    const path = await leakedItem(project);
    const before = await countRows('item_events', project.slug);
    const withBody = await send('POST', `${path}/events/scrub`, { all: true });
    expect(withBody.status).toBe(422);
    expect(await slugOf(withBody)).toBe('item-invalid');
    const withoutKey = await send('POST', `${path}/events/scrub`, {}, { key: null });
    expect(withoutKey.status).toBe(400);
    expect(await slugOf(withoutKey)).toBe('idempotency-key');
    expect(await countRows('item_events', project.slug)).toBe(before);
    expect(JSON.stringify(await eventsOf(path))).toContain(LEAK);
  });

  it('answers 404 for an unknown item', async () => {
    const project = await seedTrackerProject();
    const response = await send('POST', `${P}/${project.slug}/items/${project.keyPrefix}-9/events/scrub`);
    expect(response.status).toBe(404);
    expect(await slugOf(response)).toBe('item-not-found');
  });

  it('is the owner’s alone: every job role and the service get 403 owner-only, writing nothing', async () => {
    const project = await seedTrackerProject();
    const path = await leakedItem(project);
    const before = await countRows('item_events', project.slug);
    for (const role of ['pm', 'orchestrator', 'security', 'dev']) {
      const response = await send('POST', `${path}/events/scrub`, {}, { job: jobActor(role, 'job-x', [1]) });
      expect(response.status, role).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    }
    const service = await sendAsService('POST', `${path}/events/scrub`, {});
    expect(service.status).toBe(403);
    expect(await countRows('item_events', project.slug)).toBe(before);
  });
});
