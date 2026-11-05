import type { AskDto, AskListDto, ItemDto, ItemEventListDto } from '@shared/contracts';
import {
  PM,
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
} from '../../testing/tracker-kit';

// #434 §4: asks are job writes. The owner (and a developer role) is refused; the job seam stands in for Phase 2.

const ASK = { category: 'money', ask: 'Pay $12 a year for the domain?', commands: ['approve', 'reject'] };

async function item(path: string): Promise<ItemDto> {
  return (await (await send('GET', path)).json()) as ItemDto;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:slug/items/:key/asks', () => {
  it('records the ask, sets owner:<category> in the same batch and keeps the kind', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project, { kind: 'feature', labels: ['owner:scope', 'needs:owner'] });
    const response = await send(
      'POST',
      `${path}/asks`,
      { ...ASK, recommended: 'reject' },
      { policyActor: PM },
    );
    expect(response.status).toBe(201);
    const ask = (await response.json()) as AskDto;
    expect(ask).toMatchObject({
      category: 'money',
      ask: ASK.ask,
      commands: ['approve', 'reject'],
      recommended: 'reject',
      source: 'console',
      state: 'open',
    });
    const after = await item(path);
    expect(after.kind).toBe('feature');
    expect(after.flags).toEqual(['needs:owner', 'owner:money']);
    const events = ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
    const [labels, asked] = events.slice(-2);
    expect(labels).toMatchObject({ kind: 'labels', actor: { kind: 'job', name: 'pm' } });
    expect(asked).toMatchObject({
      kind: 'asked',
      actor: { kind: 'job', name: 'pm' },
      after: { askId: ask.id, replacedAskId: null, category: 'money' },
    });
    expect(labels?.at).toBe(asked?.at);
  });

  it('replaces the open ask instead of stacking a second one', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const first = (await (await send('POST', `${path}/asks`, ASK, { policyActor: PM })).json()) as AskDto;
    const response = await send(
      'POST',
      `${path}/asks`,
      { category: 'scope', ask: 'Rather ship without it?', commands: ['approve', 'reject'] },
      { policyActor: jobActor('architect') },
    );
    expect(response.status).toBe(201);
    const second = (await response.json()) as AskDto;
    const listed = ((await (await send('GET', `${path}/asks`)).json()) as AskListDto).asks;
    expect(listed.map((ask) => [ask.id, ask.state])).toEqual([
      [first.id, 'withdrawn'],
      [second.id, 'open'],
    ]);
    expect((await item(path)).flags).toEqual(['owner:scope']);
    const events = ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
    expect(events.at(-1)).toMatchObject({
      kind: 'asked',
      after: { askId: second.id, replacedAskId: first.id },
    });
  });

  it('answers a replayed key with the same ask and writes it once', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const key = newKey();
    const first = await send('POST', `${path}/asks`, ASK, { key, policyActor: PM });
    const again = await send('POST', `${path}/asks`, ASK, { key, policyActor: PM });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('asks', project.slug)).toBe(1);
  });

  it('refuses the owner with 403 ask-role, and every dev role', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const owner = await send('POST', `${path}/asks`, ASK);
    expect(owner.status).toBe(403);
    expect(await slugOf(owner)).toBe('ask-role');
    for (const role of ['dev', 'dev-light', 'dev-heavy']) {
      const response = await send('POST', `${path}/asks`, ASK, { policyActor: jobActor(role) });
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('ask-role');
    }
    for (const role of ['qa', 'security', 'orchestrator', 'ux-designer']) {
      const response = await send('POST', `${path}/asks`, ASK, { policyActor: jobActor(role) });
      expect(response.status).toBe(201);
    }
    expect(await countRows('asks', project.slug)).toBe(4);
  });

  it('refuses the service identity (403) and a request without identity (401)', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const service = await sendAsService('POST', `${path}/asks`, ASK);
    expect(service.status).toBe(403);
    expect(await slugOf(service)).toBe('owner-only');
    expect((await sendWithoutIdentity('POST', `${path}/asks`)).status).toBe(401);
  });

  it.each([
    [{ ...ASK, category: 'taste' }, 'category'],
    [{ ...ASK, ask: '' }, 'ask'],
    [{ ...ASK, commands: ['approve', 'merge'] }, 'commands'],
    [{ ...ASK, commands: ['approve', 'resume'] }, 'commands'],
    [{ ...ASK, recommended: 'go' }, 'recommended'],
    [{ ...ASK, jobId: 'job-forged' }, 'jobId'],
    [{ ...ASK, author: 'owner' }, 'author'],
    ['not json', 'body'],
  ])('422 ask-invalid on %j (field %s), nothing written', async (body, field) => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const response = await send('POST', `${path}/asks`, body, { policyActor: PM });
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('ask-invalid');
    expect(await response.json()).toMatchObject({ field });
    expect(await countRows('asks', project.slug)).toBe(0);
  });

  it('409 item-closed on a closed item', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project, { kind: 'chore', status: 'approved' });
    await send('PATCH', path, { status: 'done' }, { ifMatch: '"1"' });
    const response = await send('POST', `${path}/asks`, ASK, { policyActor: PM });
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('item-closed');
  });

  it('404 for an unknown project or item, 409 tracker-not-cut-over on a GitHub project', async () => {
    const project = await seedTrackerProject();
    expect(
      await slugOf(await send('POST', `/api/v1/projects/nope/items/1/asks`, ASK, { policyActor: PM })),
    ).toBe('project-not-found');
    expect(
      await slugOf(
        await send('POST', `/api/v1/projects/${project.slug}/items/99/asks`, ASK, { policyActor: PM }),
      ),
    ).toBe('item-not-found');
    const github = await seedGitHubProject();
    const refused = await send('POST', `/api/v1/projects/${github}/items/1/asks`, ASK, { policyActor: PM });
    expect(refused.status).toBe(409);
    expect(await slugOf(refused)).toBe('tracker-not-cut-over');
  });

  it('413 over the limit', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const response = await send(
      'POST',
      `${path}/asks`,
      { ...ASK, ask: 'x'.repeat(17_000) },
      { policyActor: PM },
    );
    expect(response.status).toBe(413);
  });
});

describe('GET /projects/:slug/items/:key/asks', () => {
  it('pages the asks oldest first for the owner, no-store; the service identity is refused', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    await send('POST', `${path}/asks`, ASK, { policyActor: PM });
    await send('POST', `${path}/asks`, { ...ASK, category: 'legal' }, { policyActor: PM });
    const page = await send('GET', `${path}/asks?limit=1`);
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    const first = (await page.json()) as AskListDto;
    expect(first.asks.map((ask) => ask.category)).toEqual(['money']);
    const rest = (await (await send('GET', `${path}/asks?after=${String(first.next)}`)).json()) as AskListDto;
    expect(rest).toMatchObject({ asks: [{ category: 'legal', state: 'open' }], next: null });
    expect((await send('GET', `${path}/asks`, undefined, { policyActor: PM })).status).toBe(200);
    expect(await slugOf(await sendAsService('GET', `${path}/asks`))).toBe('owner-only');
  });
});

describe('GET /projects/:slug/items/:key/asks text', () => {
  it('strips invisible characters from the job-written ask, as the inbox does (#443, #435)', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    // A right-to-left override and a zero-width space could make the owner read another question.
    const posed = `Pay ${String.fromCodePoint(0x202e)}21$${String.fromCodePoint(0x200b)} a year?`;
    expect((await send('POST', `${path}/asks`, { ...ASK, ask: posed }, { policyActor: PM })).status).toBe(201);
    const list = (await (await send('GET', `${path}/asks`)).json()) as AskListDto;
    expect(list.asks.map((ask) => ask.ask)).toEqual(['Pay 21$ a year?']);
  });
});
