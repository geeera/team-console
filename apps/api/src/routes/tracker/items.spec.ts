import { env } from 'cloudflare:test';
import type { ItemDto, ItemEventListDto, ItemListDto } from '@shared/contracts';
import {
  countRows,
  newKey,
  seedGitHubProject,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #410: the items of the console's own tracker over the API — success and the relevant 4xx for every route.

const itemsPath = (slug: string): string => `/api/v1/projects/${slug}/items`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createItem(project: SeededProject, body: Record<string, unknown> = {}): Promise<ItemDto> {
  const response = await send('POST', itemsPath(project.slug), { title: 'Item', kind: 'feature', ...body });
  expect(response.status).toBe(201);
  return (await response.json()) as ItemDto;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:slug/items', () => {
  it('creates an item keyed by the project prefix, with the full label set, an ETag and its created event', async () => {
    const project = await seedTrackerProject(412);
    const response = await send('POST', itemsPath(project.slug), {
      title: ' Own tracker​ ',
      body: 'Plain *text*, as typed',
      kind: 'feature',
      tier: 'heavy',
      labels: ['security', 'architect-note'],
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('"1"');
    expect(response.headers.get('Location')).toBe(
      `/api/v1/projects/${project.slug}/items/${project.keyPrefix}-412`,
    );
    const item = (await response.json()) as ItemDto;
    expect(item).toMatchObject({
      key: `${project.keyPrefix}-412`,
      number: 412,
      title: 'Own tracker',
      body: 'Plain *text*, as typed',
      status: 'proposed',
      labels: ['status:proposed', 'kind:feature', 'tier:heavy', 'architect-note', 'security'],
      flags: ['architect-note', 'security'],
      state: 'open',
      createdBy: { kind: 'owner', name: 'owner' },
      version: 1,
      source: 'console',
    });
    const events = (await (
      await send('GET', `${itemsPath(project.slug)}/${item.key}/events`)
    ).json()) as ItemEventListDto;
    expect(events.events).toEqual([
      expect.objectContaining({ kind: 'created', actor: { kind: 'owner', name: 'owner' }, before: null }),
    ]);
  });

  it('gives items created together distinct numbers', async () => {
    const project = await seedTrackerProject();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        send('POST', itemsPath(project.slug), { title: `T${String(n)}`, kind: 'chore' }),
      ),
    );
    const numbers = await Promise.all(
      responses.map(async (response) => ((await response.json()) as ItemDto).number),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect([...numbers].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('answers a replayed Idempotency-Key with the first result and writes no second row', async () => {
    const project = await seedTrackerProject();
    const key = newKey();
    const body = { title: 'Once', kind: 'bug', severity: 'high' };
    const first = await send('POST', itemsPath(project.slug), body, { key });
    const again = await send('POST', itemsPath(project.slug), body, { key });

    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('items', project.slug)).toBe(1);
    expect(await countRows('item_events', project.slug)).toBe(1);
  });

  it('refuses the key on a different request, and a write without a usable key', async () => {
    const project = await seedTrackerProject();
    const key = newKey();
    await send('POST', itemsPath(project.slug), { title: 'A', kind: 'bug' }, { key });
    const reused = await send('POST', itemsPath(project.slug), { title: 'B', kind: 'bug' }, { key });
    expect(reused.status).toBe(422);
    expect(await slugOf(reused)).toBe('idempotency-key-reused');

    for (const header of [null, 'short', 'has space in it', 'x'.repeat(129)]) {
      const response = await send(
        'POST',
        itemsPath(project.slug),
        { title: 'C', kind: 'bug' },
        { key: header },
      );
      expect(response.status).toBe(400);
      expect(await slugOf(response)).toBe('idempotency-key');
    }
    expect(await countRows('items', project.slug)).toBe(1);
  });

  it('never lets a different request take over a pending claim whose hold ran out', async () => {
    const project = await seedTrackerProject();
    const key = newKey();
    const path = itemsPath(project.slug);
    const raw = JSON.stringify({ title: 'First', kind: 'bug' });
    const hash = await sha256Hex(['POST', path, '', raw].join('\n'));
    // A first write whose 30 s hold has run out while it still writes.
    await env.DB.prepare(
      'INSERT INTO idempotency_keys (key, request_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(key, hash, new Date().toISOString(), Date.now() - 1)
      .run();

    const other = await send('POST', path, { title: 'Second', kind: 'bug' }, { key });
    expect(other.status).toBe(422);
    expect(await slugOf(other)).toBe('idempotency-key-reused');
    expect(await countRows('items', project.slug)).toBe(0);

    // The same request (a retry) may take it over.
    const retry = await send('POST', path, raw, { key });
    expect(retry.status).toBe(201);
    expect(await countRows('items', project.slug)).toBe(1);
  });

  it('lets the client fix a refused request under the same key', async () => {
    const project = await seedTrackerProject();
    const key = newKey();
    const refused = await send('POST', itemsPath(project.slug), { title: '', kind: 'bug' }, { key });
    expect(refused.status).toBe(422);
    // A different body under the released key is a new request.
    expect(
      (await send('POST', itemsPath(project.slug), { title: 'Fixed', kind: 'bug' }, { key })).status,
    ).toBe(201);
  });

  it('answers 409 tracker-not-cut-over for a project still on GitHub Issues and writes nothing', async () => {
    const slug = await seedGitHubProject();
    const response = await send('POST', itemsPath(slug), { title: 'T', kind: 'bug' });
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('tracker-not-cut-over');
    expect(await countRows('items', slug)).toBe(0);
  });

  it('answers 404 for an unknown or malformed project', async () => {
    for (const slug of ['nope', 'a..b', 'UPPER']) {
      const response = await send('POST', itemsPath(slug), { title: 'T', kind: 'bug' });
      expect(response.status).toBe(404);
      expect(await slugOf(response)).toBe('project-not-found');
    }
  });

  it.each([
    [{ title: 'T', kind: 'epic' }, 'kind'],
    [{ title: 'x'.repeat(257), kind: 'bug' }, 'title'],
    [{ title: 'T', kind: 'bug', body: 'x'.repeat(65_537) }, 'body'],
    [{ title: 'T', kind: 'bug', labels: ['status:qa'] }, 'labels'],
    [{ title: 'T', kind: 'bug', labels: ['not-a-project-label'] }, 'labels'],
    [{ title: 'T', kind: 'bug', sprint: 9 }, 'sprint'],
    [{ title: 'T', kind: 'bug', author: 'pm' }, 'body'],
    ['not json', 'body'],
  ])('answers 422 item-invalid naming the field for %j', async (body, field) => {
    const project = await seedTrackerProject();
    const response = await send('POST', itemsPath(project.slug), body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('item-invalid'), field });
    expect(await countRows('items', project.slug)).toBe(0);
  });

  it('answers 413 for a body over the request cap', async () => {
    const project = await seedTrackerProject();
    const response = await send('POST', itemsPath(project.slug), {
      title: 'T',
      kind: 'bug',
      body: 'x'.repeat(600_000),
    });
    expect(response.status).toBe(413);
    expect(await slugOf(response)).toBe('payload-too-large');
  });

  it('answers 403 transition-owner-only to a non-owner actor creating an approved item, writing nothing', async () => {
    const project = await seedTrackerProject();
    const response = await send(
      'POST',
      itemsPath(project.slug),
      { title: 'T', kind: 'feature', status: 'approved' },
      { job: { role: 'pm' } },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('transition-owner-only'),
      reason: 'approve',
    });
    expect(await countRows('items', project.slug)).toBe(0);
  });
});

describe('GET /projects/:slug/items and /items/:key', () => {
  it('lists open items in number order without bodies, filtered, one page at a time', async () => {
    const project = await seedTrackerProject();
    await send('POST', `/api/v1/projects/${project.slug}/sprints`, { dueOn: '2026-11-17' });
    const a = await createItem(project, { kind: 'bug', severity: 'high' });
    const b = await createItem(project, { tier: 'heavy', sprint: 1, labels: ['security'] });
    const c = await createItem(project);
    await send('PATCH', `${itemsPath(project.slug)}/${c.key}`, { status: 'done' }, { ifMatch: '"1"' });

    const list = async (query: string): Promise<ItemListDto> =>
      (await (await send('GET', `${itemsPath(project.slug)}${query}`)).json()) as ItemListDto;
    const first = await list('?limit=1');
    expect(first.items.map((item) => item.key)).toEqual([a.key]);
    expect(first.next).toBe(a.number);
    expect('body' in (first.items[0] ?? {})).toBe(false);
    expect((await list(`?limit=1&after=${String(a.number)}`)).items.map((item) => item.key)).toEqual([b.key]);
    expect((await list('?state=closed')).items.map((item) => item.key)).toEqual([c.key]);
    expect((await list('?state=all&kind=bug&severity=high')).items.map((item) => item.key)).toEqual([a.key]);
    expect((await list('?label=tier:heavy')).items.map((item) => item.key)).toEqual([b.key]);
    expect((await list('?label=security')).items.map((item) => item.key)).toEqual([b.key]);
    expect((await list('?sprint=1')).items.map((item) => item.key)).toEqual([b.key]);
    expect((await list('?sprint=none&state=all')).items.map((item) => item.key)).toEqual([a.key, c.key]);
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?after=-1',
    '?state=gone',
    '?status=shipped',
    '?label=Bad',
    '?sprint=x',
  ])('answers 400 query-invalid for %s', async (query) => {
    const project = await seedTrackerProject();
    const response = await send('GET', `${itemsPath(project.slug)}${query}`);
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe('query-invalid');
  });

  it('reads an item by key or number, with its ETag', async () => {
    const project = await seedTrackerProject(310);
    const item = await createItem(project);
    for (const key of [item.key, '310']) {
      const response = await send('GET', `${itemsPath(project.slug)}/${key}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('ETag')).toBe('"1"');
      expect(await response.json()).toEqual(item);
    }
  });

  it('answers 404 item-not-found for an unknown number or another project’s key, 400 item-key for a malformed one', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    await createItem(other);
    for (const key of ['99', `${other.keyPrefix}-1`]) {
      const response = await send('GET', `${itemsPath(project.slug)}/${key}`);
      expect(response.status).toBe(404);
      expect(await slugOf(response)).toBe('item-not-found');
    }
    const malformed = await send('GET', `${itemsPath(project.slug)}/tc-1`);
    expect(malformed.status).toBe(400);
    expect(await slugOf(malformed)).toBe('item-key');
  });

  it('lists an empty tracker for a project still on GitHub Issues', async () => {
    const slug = await seedGitHubProject();
    expect(await (await send('GET', itemsPath(slug))).json()).toEqual({ items: [], next: null });
  });
});

describe('PATCH /projects/:slug/items/:key', () => {
  it('changes the item at its version, answers the new ETag and records before and after', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project, { labels: ['needs-design'] });
    const response = await send(
      'PATCH',
      `${itemsPath(project.slug)}/${item.key}`,
      { status: 'approved', addLabels: ['design:approved'], removeLabels: ['needs-design'] },
      { ifMatch: '"1"' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"2"');
    expect(await response.json()).toMatchObject({
      status: 'approved',
      labels: ['status:approved', 'kind:feature', 'design:approved'],
      version: 2,
    });
    const events = (await (
      await send('GET', `${itemsPath(project.slug)}/${item.key}/events`)
    ).json()) as ItemEventListDto;
    expect(events.events.slice(-2)).toMatchObject([
      { kind: 'status', before: { status: 'proposed' }, after: { status: 'approved' } },
      { kind: 'labels', before: { flags: ['needs-design'] }, after: { flags: ['design:approved'] } },
    ]);
  });

  it('writes a status event beside the edit when one PATCH changes the title and the status', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    const path = `${itemsPath(project.slug)}/${item.key}`;
    const response = await send(
      'PATCH',
      path,
      { title: 'Renamed', status: 'in-progress' },
      { ifMatch: '"1"' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: 'Renamed', status: 'in-progress', version: 2 });
    const { events } = (await (await send('GET', `${path}/events`)).json()) as ItemEventListDto;
    expect(events.map((event) => [event.kind, event.before, event.after])).toEqual([
      ['created', null, expect.anything()],
      ['status', { status: 'proposed' }, { status: 'in-progress' }],
      ['edited', { title: 'Item' }, { title: 'Renamed' }],
    ]);
  });

  it('closes on done, reopens on another status, and closes as not planned', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    const path = `${itemsPath(project.slug)}/${item.key}`;
    const done = (await (
      await send('PATCH', path, { status: 'done' }, { ifMatch: '"1"' })
    ).json()) as ItemDto;
    expect(done).toMatchObject({
      state: 'closed',
      closedReason: 'done',
      labels: ['status:done', 'kind:feature'],
    });
    const reopened = (await (
      await send('PATCH', path, { status: 'qa' }, { ifMatch: '"2"' })
    ).json()) as ItemDto;
    expect(reopened).toMatchObject({ state: 'open', closedAt: null, closedReason: null });
    const dropped = await send(
      'PATCH',
      path,
      { state: 'closed', closedReason: 'not-planned' },
      { ifMatch: '"3"' },
    );
    expect(await dropped.json()).toMatchObject({
      state: 'closed',
      closedReason: 'not-planned',
      status: 'qa',
    });
    const events = (await (await send('GET', `${path}/events`)).json()) as ItemEventListDto;
    expect(events.events.map((event) => event.kind)).toEqual(['created', 'closed', 'reopened', 'closed']);
  });

  it('answers 412 item-version on a stale If-Match and writes nothing', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    const path = `${itemsPath(project.slug)}/${item.key}`;
    await send('PATCH', path, { title: 'First' }, { ifMatch: '"1"' });
    const stale = await send('PATCH', path, { title: 'Second' }, { ifMatch: '"1"' });
    expect(stale.status).toBe(412);
    expect(await slugOf(stale)).toBe('item-version');
    expect(await (await send('GET', path)).json()).toMatchObject({ title: 'First', version: 2 });
    expect(await countRows('item_events', project.slug)).toBe(2);
  });

  it('answers 428 item-version-required without a usable If-Match', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    for (const ifMatch of [undefined, '1', 'W/"1"', '"x"']) {
      const response = await send(
        'PATCH',
        `${itemsPath(project.slug)}/${item.key}`,
        { title: 'X' },
        ifMatch === undefined ? {} : { ifMatch },
      );
      expect(response.status).toBe(428);
      expect(await slugOf(response)).toBe('item-version-required');
    }
  });

  it('answers a replayed change with the item and changes nothing twice', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    const path = `${itemsPath(project.slug)}/${item.key}`;
    const key = newKey();
    const first = await send('PATCH', path, { status: 'in-progress' }, { key, ifMatch: '"1"' });
    const again = await send('PATCH', path, { status: 'in-progress' }, { key, ifMatch: '"1"' });
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('item_events', project.slug)).toBe(2);
  });

  it('answers a change to what the item already is without spending a version or an event', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    const response = await send(
      'PATCH',
      `${itemsPath(project.slug)}/${item.key}`,
      { status: 'proposed' },
      { ifMatch: '"1"' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1 });
    expect(await countRows('item_events', project.slug)).toBe(1);
  });

  it.each([
    [{}, 'body'],
    [{ state: 'closed' }, 'closedReason'],
    [{ addLabels: ['unknown-flag'] }, 'addLabels'],
    [{ sprint: 3 }, 'sprint'],
    [{ status: 'done', state: 'closed', closedReason: 'duplicate' }, 'state'],
  ])('answers 422 item-invalid for %j', async (body, field) => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    const response = await send('PATCH', `${itemsPath(project.slug)}/${item.key}`, body, { ifMatch: '"1"' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field });
  });

  it('answers 404 for an unknown item and 409 on a project still on GitHub Issues', async () => {
    const project = await seedTrackerProject();
    const missing = await send('PATCH', `${itemsPath(project.slug)}/77`, { title: 'X' }, { ifMatch: '"1"' });
    expect(missing.status).toBe(404);
    expect(await slugOf(missing)).toBe('item-not-found');
    const slug = await seedGitHubProject();
    const gated = await send('PATCH', `${itemsPath(slug)}/1`, { title: 'X' }, { ifMatch: '"1"' });
    expect(gated.status).toBe(409);
    expect(await slugOf(gated)).toBe('tracker-not-cut-over');
  });

  it.each([
    ['approving a proposed item', { status: 'approved' }, 'approve'],
    ['approving a design', { addLabels: ['design:approved'] }, 'design-approved'],
    ['setting an owner flag', { addLabels: ['owner:scope'] }, 'owner-flag'],
  ])(
    'answers 403 transition-owner-only to a non-owner actor %s, writing nothing',
    async (_, body, reason) => {
      const project = await seedTrackerProject();
      const item = await createItem(project);
      const response = await send('PATCH', `${itemsPath(project.slug)}/${item.key}`, body, {
        ifMatch: '"1"',
        job: { role: 'orchestrator', items: [1] },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        type: expect.stringContaining('transition-owner-only'),
        reason,
      });
      expect(await (await send('GET', `${itemsPath(project.slug)}/${item.key}`)).json()).toMatchObject({
        version: 1,
      });
      expect(await countRows('item_events', project.slug)).toBe(1);
    },
  );

  it('answers 403 transition-role when a role steps outside the table, e.g. workflow-change by the PM', async () => {
    const project = await seedTrackerProject();
    await send('POST', `/api/v1/projects/${project.slug}/labels`, {
      name: 'workflow-change',
      color: 'b60205',
    });
    const item = await createItem(project);
    const response = await send(
      'PATCH',
      `${itemsPath(project.slug)}/${item.key}`,
      { addLabels: ['workflow-change'] },
      { ifMatch: '"1"', job: { role: 'pm', items: [1] } },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('transition-role'),
      reason: 'workflow-change',
    });
  });
});

describe('GET /projects/:slug/items/:key/events', () => {
  it('pages the audit trail by event id', async () => {
    const project = await seedTrackerProject();
    const item = await createItem(project);
    await send('PATCH', `${itemsPath(project.slug)}/${item.key}`, { title: 'Two' }, { ifMatch: '"1"' });
    const path = `${itemsPath(project.slug)}/${item.key}/events`;
    const first = (await (await send('GET', `${path}?limit=1`)).json()) as ItemEventListDto;
    expect(first.events.map((event) => event.kind)).toEqual(['created']);
    const rest = (await (
      await send('GET', `${path}?after=${String(first.next)}`)
    ).json()) as ItemEventListDto;
    expect(rest).toMatchObject({ events: [{ kind: 'edited', after: { title: 'Two' } }], next: null });
    expect((await send('GET', `${itemsPath(project.slug)}/404/events`)).status).toBe(404);
  });
});

describe('the item routes are the owner’s', () => {
  const routes: [string, string][] = [
    ['GET', '/items'],
    ['POST', '/items'],
    ['GET', '/items/1'],
    ['PATCH', '/items/1'],
    ['GET', '/items/1/events'],
  ];

  it.each(routes)('%s %s answers 401 without an Access identity', async (method, route) => {
    const project = await seedTrackerProject();
    const response = await sendWithoutIdentity(method, `/api/v1/projects/${project.slug}${route}`);
    expect(response.status).toBe(401);
  });

  it.each(routes)('%s %s answers 403 owner-only to the service identity', async (method, route) => {
    const project = await seedTrackerProject();
    await createItem(project);
    const response = await sendAsService(method, `/api/v1/projects/${project.slug}${route}`, {
      title: 'T',
      kind: 'bug',
    });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
    expect(await countRows('items', project.slug)).toBe(1);
  });

  it('refuses a cross-site write (CSRF) before the route runs', async () => {
    const project = await seedTrackerProject();
    const response = await send(
      'POST',
      itemsPath(project.slug),
      { title: 'T', kind: 'bug' },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    );
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('csrf');
    expect(await countRows('items', project.slug)).toBe(0);
  });
});
