import { env } from 'cloudflare:test';
import type {
  AskListDto,
  CommentDto,
  CommentListDto,
  ItemEventDto,
  ItemEventListDto,
  ItemRequestDto,
  ItemRequestListDto,
  TrackerSprintDto,
} from '@shared/contracts';
import {
  PM,
  countRows,
  jobActor,
  newKey,
  seedAsk,
  seedItem,
  seedTrackerProject,
  send,
  sendAsService,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #477 (finding 5 of the security review of #474): the owner's scrub beyond an item's title and body — comments,
// asks, the PM's reason on a request, `imported` events and a sprint's title and description. Owner only, audited,
// and nothing but the named text changes: each case compares the whole row before and after.

const P = '/api/v1/projects';
const MARK = '[scrubbed]';
// Assembled at run time so the repository's secret scan never sees a token-shaped literal.
const LEAK = ['gh', 'p_', 'Z9y8'.repeat(9)].join('');
// A credential no pattern knows (a password): what a job's text can still carry past the 422 `body-secret` check.
const PLAIN_LEAK = 'correct-horse-battery-staple-4471';

type Row = Record<string, unknown>;
type Table = 'comments' | 'asks' | 'item_requests' | 'item_events' | 'sprints' | 'items';

const ITEM_TABLES: Readonly<Record<Exclude<Table, 'sprints' | 'items'>, string>> = {
  comments: 'item_id IN (SELECT id FROM items WHERE project_slug = ?1)',
  asks: 'project_slug = ?1',
  item_requests: 'project_slug = ?1',
  item_events: 'item_id IN (SELECT id FROM items WHERE project_slug = ?1)',
};

/** Every row of `table` in the project, whole, in id order. */
async function rowsOf(table: Table, slug: string): Promise<Row[]> {
  const where = table === 'sprints' || table === 'items' ? 'project_slug = ?1' : ITEM_TABLES[table];
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`)
    .bind(slug)
    .all<Row>();
  return results;
}

async function auditOf(slug: string): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    `SELECT actor_kind, actor, kind, target, details FROM audit_events
     WHERE kind = 'tracker.scrubbed' AND target = ?1 ORDER BY id`,
  )
    .bind(slug)
    .all<Row>();
  return results.map((row) => ({ ...row, details: JSON.parse(String(row['details'])) as unknown }));
}

interface Incident {
  readonly project: SeededProject;
  readonly path: string;
  readonly comment: CommentDto;
  readonly cleanComment: CommentDto;
  readonly askId: number;
  readonly request: ItemRequestDto;
}

/** An item whose comment, ask and request reason each carry a credential, beside a clean comment. */
async function incident(): Promise<Incident> {
  const project = await seedTrackerProject();
  const { path } = await seedItem(project, { kind: 'feature', status: 'approved', title: 'Deploy' });
  const comment = await send('POST', `${path}/comments`, { body: `I pasted ${LEAK} by mistake` });
  const cleanComment = await send('POST', `${path}/comments`, { body: 'Nothing to see' });
  const ask = await seedAsk(path, { ask: `Keep the password ${PLAIN_LEAK}?` });
  const requested = await send('POST', `${path}/requests`, { kind: 'sprint', target: 'next' });
  expect([comment.status, cleanComment.status, requested.status]).toEqual([201, 201, 201]);
  const request = (await requested.json()) as ItemRequestDto;
  const handled = await send(
    'POST',
    `${P}/${project.slug}/requests/${String(request.id)}/handled`,
    { result: 'declined', reason: `Declined: the password ${PLAIN_LEAK} is in the plan` },
    { job: PM },
  );
  expect(handled.status).toBe(200);
  return {
    project,
    path,
    comment: (await comment.json()) as CommentDto,
    cleanComment: (await cleanComment.json()) as CommentDto,
    askId: ask.id,
    request,
  };
}

/** The whole project as stored: the tables a scrub could reach. */
async function stored(slug: string): Promise<Record<Table, Row[]>> {
  const [comments, asks, requests, events, sprints, items] = await Promise.all([
    rowsOf('comments', slug),
    rowsOf('asks', slug),
    rowsOf('item_requests', slug),
    rowsOf('item_events', slug),
    rowsOf('sprints', slug),
    rowsOf('items', slug),
  ]);
  return { comments, asks, item_requests: requests, item_events: events, sprints, items };
}

const withText = (rows: readonly Row[], id: number, column: string): Row[] =>
  rows.map((row) => (row['id'] === id ? { ...row, [column]: MARK } : row));

describe('POST /projects/:slug/items/:key/events/scrub with members (#477)', () => {
  it('masks the named comment, ask and request reason, and nothing else of any row', async () => {
    const { project, path, comment, cleanComment, askId, request } = await incident();
    const before = await stored(project.slug);
    expect(JSON.stringify(before)).toContain(LEAK);
    expect(JSON.stringify(before)).toContain(PLAIN_LEAK);

    const response = await send('POST', `${path}/events/scrub`, {
      comments: [comment.id],
      asks: [askId],
      requests: [request.id],
    });

    expect(response.status).toBe(201);
    const scrub = (await response.json()) as ItemEventDto;
    expect(scrub).toMatchObject({
      kind: 'scrubbed',
      actor: { kind: 'owner' },
      before: null,
      after: { events: 0, fields: [], comments: [comment.id], asks: [askId], requests: [request.id] },
    });

    const after = await stored(project.slug);
    expect(JSON.stringify(after)).not.toContain(LEAK);
    expect(JSON.stringify(after)).not.toContain(PLAIN_LEAK);
    // Author, kind, time, job, source, reversal; category, commands, answer; handler, result, time: all as they were.
    expect(after.comments).toEqual(withText(before.comments, comment.id, 'body'));
    expect(after.asks).toEqual(withText(before.asks, askId, 'ask'));
    expect(after.item_requests).toEqual(withText(before.item_requests, request.id, 'reason'));
    // The history was not asked for: every earlier event is untouched, and the scrub added exactly its own.
    expect(after.item_events.slice(0, -1)).toEqual(before.item_events);
    expect(after.item_events.at(-1)).toMatchObject({ kind: 'scrubbed', actor_kind: 'owner' });
    expect(after.items).toEqual(before.items);

    // As the console and the plugin read them.
    const comments = ((await (await send('GET', `${path}/comments`)).json()) as CommentListDto).comments;
    expect(comments.map((row) => [row.id, row.body, row.author.kind])).toEqual([
      [comment.id, MARK, 'owner'],
      [cleanComment.id, 'Nothing to see', 'owner'],
    ]);
    const asks = ((await (await send('GET', `${path}/asks`)).json()) as AskListDto).asks;
    expect(asks).toMatchObject([{ id: askId, ask: MARK, state: 'open', commands: ['approve', 'reject'] }]);
    const requests = ((await (await send('GET', `${path}/requests`)).json()) as ItemRequestListDto).requests;
    expect(requests).toMatchObject([{ id: request.id, result: 'declined', reason: MARK }]);
  });

  it('writes one audit row with ids only, in the scrub’s own batch', async () => {
    const { project, path, comment, askId, request } = await incident();
    const response = await send('POST', `${path}/events/scrub`, {
      events: true,
      comments: [comment.id],
      asks: [askId],
      requests: [request.id],
    });
    expect(response.status).toBe(201);
    const audit = await auditOf(project.slug);
    expect(audit).toEqual([
      {
        actor_kind: 'user',
        actor: 'local-owner',
        kind: 'tracker.scrubbed',
        target: project.slug,
        details: { item: 1, events: true, comments: [comment.id], asks: [askId], requests: [request.id] },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(LEAK);
    expect(JSON.stringify(audit)).not.toContain(PLAIN_LEAK);
  });

  it('audits the history-only scrub of #462 too', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    expect((await send('POST', `${path}/events/scrub`, {})).status).toBe(201);
    expect(await auditOf(project.slug)).toMatchObject([
      { kind: 'tracker.scrubbed', details: { item: 1, events: true, comments: [], asks: [], requests: [] } },
    ]);
  });

  it('masks the history with the rows when events is true', async () => {
    const { project, path, comment } = await incident();
    const etag = (await send('GET', path)).headers.get('ETag') ?? '';
    const renamed = await send('PATCH', path, { title: `Deploy ${LEAK}` }, { ifMatch: etag });
    expect(renamed.status).toBe(200);
    const response = await send('POST', `${path}/events/scrub`, { events: true, comments: [comment.id] });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      after: { events: 2, fields: ['title', 'body'], comments: [comment.id] },
    });
    const events = ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
    expect(JSON.stringify(events)).not.toContain(LEAK);
    expect(JSON.stringify(await rowsOf('comments', project.slug))).not.toContain(LEAK);
  });

  it('masks the title and body an imported event keeps, and keeps its other members and its author', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    // As the import (#437) will write it: the imported text under `title` and `body`.
    await env.DB.prepare(
      `INSERT INTO item_events (item_id, at, actor_kind, actor, kind, before, after)
       SELECT id, '2026-11-01T00:00:00.000Z', 'import', 'octocat', 'imported', NULL, ?2
       FROM items WHERE project_slug = ?1`,
    )
      .bind(
        project.slug,
        JSON.stringify({ title: `Token ${LEAK}`, body: LEAK, source: 'github', number: 310 }),
      )
      .run();
    const before = await rowsOf('item_events', project.slug);

    expect((await send('POST', `${path}/events/scrub`)).status).toBe(201);

    const events = ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
    expect(JSON.stringify(events)).not.toContain(LEAK);
    expect(events.find((event) => event.kind === 'imported')).toMatchObject({
      actor: { kind: 'import', name: 'octocat' },
      before: null,
      after: { title: MARK, body: MARK, source: 'github', number: 310 },
    });
    const after = await rowsOf('item_events', project.slug);
    const imported = before.find((row) => row['kind'] === 'imported');
    expect(after.find((row) => row['kind'] === 'imported')).toEqual({
      ...imported,
      after: JSON.stringify({ title: MARK, body: MARK, source: 'github', number: 310 }),
    });
  });

  it('answers a replayed key with the same scrubbed event, writing no second event or audit row', async () => {
    const { project, path, comment } = await incident();
    const key = newKey();
    const first = await send('POST', `${path}/events/scrub`, { comments: [comment.id] }, { key });
    const again = await send('POST', `${path}/events/scrub`, { comments: [comment.id] }, { key });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(((await again.json()) as ItemEventDto).id).toBe(((await first.json()) as ItemEventDto).id);
    expect(await auditOf(project.slug)).toHaveLength(1);
    expect(
      (await rowsOf('item_events', project.slug)).filter((row) => row['kind'] === 'scrubbed'),
    ).toHaveLength(1);
  });

  it('refuses rows that are not this item’s, naming the ids, and writes nothing', async () => {
    const { project, path, comment, askId, request } = await incident();
    const other = await seedItem(project, { kind: 'feature', status: 'approved', title: 'Other' });
    const foreignComment = (await (
      await send('POST', `${other.path}/comments`, { body: `also ${LEAK}` })
    ).json()) as CommentDto;
    const pending = (await (
      await send('POST', `${other.path}/requests`, { kind: 'sprint', target: 'next' })
    ).json()) as ItemRequestDto;
    const pendingHere = (await (
      await send('POST', `${path}/requests`, { kind: 'sprint', target: 'current' })
    ).json()) as ItemRequestDto;
    const before = await stored(project.slug);

    const cases: readonly [Record<string, unknown>, string, string][] = [
      [{ comments: [comment.id, foreignComment.id] }, 'comments', String(foreignComment.id)],
      [{ comments: [999_999] }, 'comments', '999999'],
      [{ asks: [askId + 1000] }, 'asks', String(askId + 1000)],
      [{ requests: [request.id, pending.id] }, 'requests', String(pending.id)],
      // The item's own request, but nobody answered it: it has no reason to mask.
      [{ requests: [pendingHere.id] }, 'requests', String(pendingHere.id)],
    ];
    for (const [body, field, id] of cases) {
      const response = await send('POST', `${path}/events/scrub`, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await slugOf(response)).toBe('item-invalid');
      const problem = (await response.json()) as { field: string; detail: string };
      expect(problem.field).toBe(field);
      expect(problem.detail).toContain(id);
    }
    // This item's ask, named through another item's path, is not that item's.
    const viaOtherItem = await send('POST', `${other.path}/events/scrub`, { asks: [askId] });
    expect(viaOtherItem.status).toBe(422);

    expect(await stored(project.slug)).toEqual(before);
    expect(await auditOf(project.slug)).toEqual([]);
  });

  it.each([
    [{ events: false }, 'body'],
    [{ comments: [] }, 'comments'],
    [{ comments: [1, 1] }, 'comments'],
    [{ asks: ['1'] }, 'asks'],
    [{ requests: 3 }, 'requests'],
    [{ comments: [1], body: MARK }, 'body'],
    [{ comments: [1], text: 'replacement' }, 'body'],
  ])('answers 422 item-invalid for %j, writing nothing', async (body, field) => {
    const { project, path } = await incident();
    const before = await stored(project.slug);
    const response = await send('POST', `${path}/events/scrub`, body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('item-invalid');
    expect(((await response.json()) as { field: string }).field).toBe(field);
    expect(await stored(project.slug)).toEqual(before);
  });

  // Security review of #912: a body that is sent but is not a JSON object must never read as "no body", which
  // would run the whole history scrub on an owner's typo.
  it.each([
    ['malformed JSON', '{"comments": [1'],
    ['a truncated empty object', '{'],
    ['whitespace only', ' '],
    ['a JSON array', '[]'],
    ['a JSON array of ids', '[1, 2]'],
    ['a JSON string', '"{}"'],
    ['JSON null', 'null'],
  ])('refuses %s as a body with 422 item-invalid, masking nothing', async (_, raw) => {
    const { project, path } = await incident();
    const etag = (await send('GET', path)).headers.get('ETag') ?? '';
    expect((await send('PATCH', path, { title: `Deploy ${LEAK}` }, { ifMatch: etag })).status).toBe(200);
    const before = await stored(project.slug);

    const response = await send('POST', `${path}/events/scrub`, raw);

    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('item-invalid');
    expect(((await response.json()) as { field: string }).field).toBe('body');
    expect(await stored(project.slug)).toEqual(before);
    expect(JSON.stringify(before.item_events)).toContain(LEAK);
    expect(await auditOf(project.slug)).toEqual([]);
  });

  it('still takes an absent body and {} as the history alone', async () => {
    const { project, path } = await incident();
    expect((await send('POST', `${path}/events/scrub`)).status).toBe(201);
    expect((await send('POST', `${path}/events/scrub`, '{}')).status).toBe(201);
    expect(await auditOf(project.slug)).toHaveLength(2);
  });

  it('is the owner’s alone with members too: every job role and the service get 403, writing nothing', async () => {
    const { project, path, comment, askId, request } = await incident();
    const before = await stored(project.slug);
    const body = { comments: [comment.id], asks: [askId], requests: [request.id] };
    for (const role of ['pm', 'orchestrator', 'security', 'dev', 'qa', 'reviewer']) {
      const response = await send('POST', `${path}/events/scrub`, body, {
        job: jobActor(role, 'job-x', [1]),
      });
      expect(response.status, role).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    }
    expect((await sendAsService('POST', `${path}/events/scrub`, body)).status).toBe(403);
    expect(await stored(project.slug)).toEqual(before);
    expect(await auditOf(project.slug)).toEqual([]);
  });
});

describe('POST /projects/:slug/sprints/:number/scrub (#477)', () => {
  const sprintsPath = (slug: string): string => `${P}/${slug}/sprints`;

  async function leakedSprint(): Promise<{ project: SeededProject; path: string }> {
    const project = await seedTrackerProject();
    const created = await send('POST', sprintsPath(project.slug), {
      title: `Rotate ${LEAK}`,
      description: `The deploy key is ${LEAK}`,
      dueOn: null,
    });
    expect(created.status).toBe(201);
    const neighbour = await send('POST', sprintsPath(project.slug), {
      title: 'Checkout',
      description: 'Clean',
    });
    expect(neighbour.status).toBe(201);
    return { project, path: `${sprintsPath(project.slug)}/1` };
  }

  it('masks the title and the description, keeps every other column, and leaves the next sprint alone', async () => {
    const { project, path } = await leakedSprint();
    const [before, neighbour] = await rowsOf('sprints', project.slug);

    const response = await send('POST', `${path}/scrub`, { fields: ['title', 'description'] });

    expect(response.status).toBe(200);
    const sprint = (await response.json()) as TrackerSprintDto;
    expect(sprint).toMatchObject({ number: 1, title: `${MARK} 1`, description: MARK, state: 'open' });
    const after = await rowsOf('sprints', project.slug);
    expect(JSON.stringify(after)).not.toContain(LEAK);
    expect(after).toEqual([
      { ...before, title: `${MARK} 1`, title_key: `${MARK} 1`, description: MARK },
      neighbour,
    ]);
    expect(await (await send('GET', path)).json()).toMatchObject({ title: `${MARK} 1`, description: MARK });
  });

  it('masks only the field it names', async () => {
    const { project, path } = await leakedSprint();
    const [before] = await rowsOf('sprints', project.slug);
    expect((await send('POST', `${path}/scrub`, { fields: ['description'] })).status).toBe(200);
    expect((await rowsOf('sprints', project.slug))[0]).toEqual({ ...before, description: MARK });
  });

  it('writes one audit row naming the sprint and the fields, never the text', async () => {
    const { project, path } = await leakedSprint();
    const key = newKey();
    const first = await send('POST', `${path}/scrub`, { fields: ['description', 'title'] }, { key });
    const again = await send('POST', `${path}/scrub`, { fields: ['description', 'title'] }, { key });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    const audit = await auditOf(project.slug);
    expect(audit).toEqual([
      {
        actor_kind: 'user',
        actor: 'local-owner',
        kind: 'tracker.scrubbed',
        target: project.slug,
        details: { sprint: 1, fields: ['title', 'description'] },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(LEAK);
  });

  it('gives two scrubbed sprints of a project their own titles', async () => {
    const { project, path } = await leakedSprint();
    expect((await send('POST', `${path}/scrub`, { fields: ['title'] })).status).toBe(200);
    const second = await send('POST', `${sprintsPath(project.slug)}/2/scrub`, { fields: ['title'] });
    expect(second.status).toBe(200);
    expect((await rowsOf('sprints', project.slug)).map((row) => row['title'])).toEqual([
      `${MARK} 1`,
      `${MARK} 2`,
    ]);
  });

  it.each([
    [{}, 'fields'],
    [{ fields: [] }, 'fields'],
    [{ fields: ['state'] }, 'fields'],
    [{ fields: ['title'], title: 'A new name' }, 'body'],
    [{ fields: ['description'], dueOn: '2027-01-01' }, 'body'],
  ])('answers 422 sprint-invalid for %j, writing nothing', async (body, field) => {
    const { project, path } = await leakedSprint();
    const before = await rowsOf('sprints', project.slug);
    const response = await send('POST', `${path}/scrub`, body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('sprint-invalid');
    expect(((await response.json()) as { field: string }).field).toBe(field);
    expect(await rowsOf('sprints', project.slug)).toEqual(before);
    expect(await auditOf(project.slug)).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{"fields": ["title"'],
    ['a JSON array', '["title"]'],
    ['a JSON string', '"title"'],
    ['no body', undefined],
  ])('refuses %s as a body with 422 sprint-invalid, masking nothing', async (_, raw) => {
    const { project, path } = await leakedSprint();
    const before = await rowsOf('sprints', project.slug);
    const response = await send('POST', `${path}/scrub`, raw);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('sprint-invalid');
    expect(((await response.json()) as { field: string }).field).toBe('body');
    expect(await rowsOf('sprints', project.slug)).toEqual(before);
    expect(await auditOf(project.slug)).toEqual([]);
  });

  it('answers 404 for an unknown sprint and 400 without an Idempotency-Key', async () => {
    const { project, path } = await leakedSprint();
    const unknown = await send('POST', `${sprintsPath(project.slug)}/9/scrub`, { fields: ['title'] });
    expect(unknown.status).toBe(404);
    expect(await slugOf(unknown)).toBe('sprint-not-found');
    const withoutKey = await send('POST', `${path}/scrub`, { fields: ['title'] }, { key: null });
    expect(withoutKey.status).toBe(400);
    expect(await slugOf(withoutKey)).toBe('idempotency-key');
  });

  it('is the owner’s alone: the PM who plans sprints, every other role and the service get 403', async () => {
    const { project, path } = await leakedSprint();
    const before = await rowsOf('sprints', project.slug);
    for (const role of ['pm', 'orchestrator', 'security', 'dev', 'qa']) {
      const response = await send(
        'POST',
        `${path}/scrub`,
        { fields: ['title'] },
        { job: jobActor(role, 'job-x') },
      );
      expect(response.status, role).toBe(403);
      expect(await slugOf(response)).toBe('owner-only');
    }
    expect((await sendAsService('POST', `${path}/scrub`, { fields: ['title'] })).status).toBe(403);
    expect(await rowsOf('sprints', project.slug)).toEqual(before);
    expect(await countRows('sprints', project.slug)).toBe(2);
  });
});
