import type {
  AskListDto,
  CommentListDto,
  DecisionDto,
  DecisionListDto,
  ItemDto,
  ItemEventDto,
  ItemEventListDto,
} from '@shared/contracts';
import { ItemsRepo } from '@worker/db';
import {
  PM,
  countRows,
  newKey,
  seedAsk,
  seedGitHubProject,
  seedImportedAsk,
  seedItem,
  seedTeamDecision,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #434 §5: owner decisions and their effects (R5) in one batch; the owner identity only.

async function item(path: string): Promise<ItemDto> {
  return (await (await send('GET', path)).json()) as ItemDto;
}

async function events(path: string): Promise<readonly ItemEventDto[]> {
  return ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
}

async function decide(
  path: string,
  body: unknown,
  options: Parameters<typeof send>[3] = {},
): Promise<Response> {
  return send('POST', `${path}/decisions`, body, options);
}

async function seeded(
  labels: string[] = [],
  kind: 'question' | 'feature' | 'chore' = 'question',
): Promise<{ project: SeededProject; path: string }> {
  const project = await seedTrackerProject();
  const { path } = await seedItem(project, { kind, labels });
  return { project, path };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:slug/items/:key/decisions — effects (R5)', () => {
  it('approves a proposed question and answers its ask: decided, status and answered in the same batch', async () => {
    const { project, path } = await seeded();
    const ask = await seedAsk(path);
    const response = await decide(path, { command: 'approve', askId: ask.id, via: 'web' });
    expect(response.status).toBe(201);
    const decision = (await response.json()) as DecisionDto;
    expect(decision).toMatchObject({
      command: 'approve',
      askId: ask.id,
      via: 'web',
      text: '',
      sourceUrl: null,
    });
    expect(await item(path)).toMatchObject({ status: 'approved', version: 3 });
    const asks = ((await (await send('GET', `${path}/asks`)).json()) as AskListDto).asks;
    expect(asks).toMatchObject([{ id: ask.id, state: 'answered', answeredByDecisionId: decision.id }]);
    const trail = (await events(path)).slice(-3);
    expect(trail.map((event) => event.kind)).toEqual(['status', 'decided', 'answered']);
    expect(new Set(trail.map((event) => event.at)).size).toBe(1);
    expect(trail.every((event) => event.actor.kind === 'owner')).toBe(true);
    expect(trail[0]).toMatchObject({ before: { status: 'proposed' }, after: { status: 'approved' } });
    expect(trail[1]?.after).toEqual({ decisionId: decision.id, command: 'approve', askId: ask.id });
    expect(trail[2]?.after).toEqual({ askId: ask.id, decisionId: decision.id });
    const listed = (await (await send('GET', `${path}/decisions`)).json()) as DecisionListDto;
    expect(listed).toEqual({ decisions: [decision], next: null });
    expect(await countRows('owner_decisions', project.slug)).toBe(1);
  });

  it('proves R5 end to end: the PM job cannot approve, the owner decision does', async () => {
    const { path } = await seeded();
    const patched = await send('PATCH', path, { status: 'approved' }, { ifMatch: '"1"', policyActor: PM });
    expect(patched.status).toBe(403);
    expect(await slugOf(patched)).toBe('transition-owner-only');
    const response = await decide(path, { command: 'approve', via: 'push' });
    expect(response.status).toBe(201);
    expect((await item(path)).status).toBe('approved');
    const [status, decided] = (await events(path)).slice(-2);
    expect([status?.kind, decided?.kind]).toEqual(['status', 'decided']);
    expect(status?.at).toBe(decided?.at);
  });

  it('a question reject changes nothing on the item but records the reason', async () => {
    const { path } = await seeded();
    const response = await decide(path, { command: 'reject', text: 'Not now', via: 'web' });
    expect(response.status).toBe(201);
    expect(await item(path)).toMatchObject({ status: 'proposed', version: 1 });
    expect((await events(path)).at(-1)).toMatchObject({
      kind: 'decided',
      after: { command: 'reject', askId: null },
    });
  });

  it('a design approve sets design:approved, drops awaiting-approval and approves a proposed item', async () => {
    const { path } = await seeded(['design:awaiting-approval'], 'feature');
    expect((await decide(path, { command: 'approve', via: 'web' })).status).toBe(201);
    expect(await item(path)).toMatchObject({ status: 'approved', flags: ['design:approved'] });
  });

  it('a design reject drops awaiting-approval so the designer re-submits', async () => {
    const { path } = await seeded(['design:awaiting-approval'], 'feature');
    expect((await decide(path, { command: 'reject', text: 'Too dense', via: 'web' })).status).toBe(201);
    expect(await item(path)).toMatchObject({ status: 'proposed', flags: [] });
  });

  it.each(['go', 'no-go', 'override'])('a release %s closes the demo item as done', async (command) => {
    const { path } = await seeded(['team:demo'], 'chore');
    const response = await decide(path, { command, text: 'Reason', via: 'web' });
    expect(response.status).toBe(201);
    expect(await item(path)).toMatchObject({ status: 'done', state: 'closed', closedReason: 'done' });
  });

  it.each([
    ['needs:owner', 'owner'],
    ['needs:local', 'local'],
  ])('done on a %s item removes the flag', async (flag) => {
    const { path } = await seeded([flag], 'chore');
    expect((await decide(path, { command: 'done', via: 'web' })).status).toBe(201);
    expect((await item(path)).flags).toEqual([]);
  });
});

describe('POST /projects/:slug/items/:key/decisions — what the item accepts', () => {
  it('422 decision-command on an item that is not waiting for the owner, or a closed one', async () => {
    const { path } = await seeded([], 'feature');
    const response = await decide(path, { command: 'approve', via: 'web' });
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('decision-command');
    const demo = await seeded(['team:demo'], 'chore');
    await decide(demo.path, { command: 'go', via: 'web' });
    expect(await slugOf(await decide(demo.path, { command: 'go', via: 'web' }))).toBe('decision-command');
  });

  it('422 decision-command outside the section or the open ask’s commands, and for resume until Phase 4', async () => {
    const { project, path } = await seeded();
    expect(await slugOf(await decide(path, { command: 'go', via: 'web' }))).toBe('decision-command');
    expect(await slugOf(await decide(path, { command: 'resume', via: 'web' }))).toBe('decision-command');
    const ask = await seedAsk(path, { commands: ['approve'] });
    const refused = await decide(path, { command: 'reject', text: 'No', askId: ask.id, via: 'web' });
    expect(refused.status).toBe(422);
    expect(await slugOf(refused)).toBe('decision-command');
    expect(await countRows('owner_decisions', project.slug)).toBe(0);
  });

  it.each(['reject', 'no-go', 'override'])('422 on text when %s comes without a reason', async (command) => {
    const { path } = await seeded(
      command === 'reject' ? [] : ['team:demo'],
      command === 'reject' ? 'question' : 'chore',
    );
    const response = await decide(path, { command, text: '  ', via: 'web' });
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('decision-invalid');
    expect(await response.json()).toMatchObject({ field: 'text' });
  });

  it('409 ask-not-open when the ask was replaced since the owner read it; nothing written', async () => {
    const { project, path } = await seeded();
    const first = await seedAsk(path);
    await seedAsk(path, { category: 'legal' });
    const response = await decide(path, { command: 'approve', askId: first.id, via: 'web' });
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('ask-not-open');
    expect(await countRows('owner_decisions', project.slug)).toBe(0);
    expect((await item(path)).status).toBe('proposed');
  });

  it('409 ask-imported on an imported open ask (R7), with or without askId', async () => {
    const { project, path } = await seeded();
    const number = (await item(path)).number;
    const imported = await seedImportedAsk(project.slug, number);
    for (const body of [
      { command: 'approve', via: 'web' },
      { command: 'approve', askId: imported, via: 'web' },
    ]) {
      const response = await decide(path, body);
      expect(response.status).toBe(409);
      expect(await slugOf(response)).toBe('ask-imported');
    }
    expect(await countRows('owner_decisions', project.slug)).toBe(0);
  });

  it('answers the open console ask even without askId', async () => {
    const { path } = await seeded();
    const ask = await seedAsk(path);
    const decision = (await (await decide(path, { command: 'approve', via: 'web' })).json()) as DecisionDto;
    expect(decision.askId).toBe(ask.id);
  });
});

describe('POST /projects/:slug/items/:key/decisions — reversing a team decision', () => {
  it('a reject reverses a team decision once', async () => {
    const { project, path } = await seeded();
    const number = (await item(path)).number;
    const commentId = await seedTeamDecision(project.slug, number);
    const response = await decide(path, {
      command: 'reject',
      text: 'Export first',
      reversesCommentId: commentId,
      via: 'web',
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as DecisionDto).reversesCommentId).toBe(commentId);
    const again = await decide(path, {
      command: 'reject',
      text: 'Again',
      reversesCommentId: commentId,
      via: 'web',
    });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ field: 'reversesCommentId' });
  });

  it('422 reversesCommentId with another command, on a plain comment or an unknown id', async () => {
    const { project, path } = await seeded();
    const number = (await item(path)).number;
    const commentId = await seedTeamDecision(project.slug, number);
    const plain = (
      (await (await send('POST', `${path}/comments`, { body: 'just a comment' })).json()) as { id: number }
    ).id;
    for (const body of [
      { command: 'approve', reversesCommentId: commentId, via: 'web' },
      { command: 'reject', text: 'x', reversesCommentId: plain, via: 'web' },
      { command: 'reject', text: 'x', reversesCommentId: 999_999, via: 'web' },
    ]) {
      const response = await decide(path, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ field: 'reversesCommentId' });
    }
    const comments = ((await (await send('GET', `${path}/comments`)).json()) as CommentListDto).comments;
    expect(comments).toHaveLength(2);
  });
});

describe('POST /projects/:slug/items/:key/decisions — forgery, replay, races', () => {
  it.each(['author', 'authorKind', 'jobId', 'decidedAt', 'projectSlug', 'itemId'])(
    '422 naming the forged member %s, nothing written',
    async (member) => {
      const { project, path } = await seeded();
      const response = await decide(path, { command: 'approve', via: 'web', [member]: 'forged' });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ field: member });
      expect(await countRows('owner_decisions', project.slug)).toBe(0);
    },
  );

  it.each([
    [{ command: 'approve', via: 'import' }, 'via'],
    [{ command: 'approve' }, 'via'],
    [{ command: 'merge', via: 'web' }, 'command'],
    [{ command: 'approve', via: 'web', text: 'x'.repeat(2001) }, 'text'],
    [{ command: 'approve', via: 'web', askId: -1 }, 'askId'],
    [{ command: 'approve', via: 'web', ownerSaid: 'yes' }, 'body'],
    ['not json', 'body'],
  ])('422 decision-invalid on %j (field %s)', async (body, field) => {
    const { path } = await seeded();
    const response = await decide(path, body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('decision-invalid');
    expect(await response.json()).toMatchObject({ field });
  });

  it('a replayed key answers the same decision: one row, one status event', async () => {
    const { project, path } = await seeded();
    const key = newKey();
    const first = await decide(path, { command: 'approve', via: 'web' }, { key });
    const again = await decide(path, { command: 'approve', via: 'web' }, { key });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('owner_decisions', project.slug)).toBe(1);
    expect((await events(path)).filter((event) => event.kind === 'status')).toHaveLength(1);
  });

  it('ignores a stray If-Match (a decision is about the ask, not a version)', async () => {
    const { path } = await seeded();
    expect((await decide(path, { command: 'approve', via: 'web' }, { ifMatch: '"42"' })).status).toBe(201);
  });

  it('re-reads once on a moved version and answers 409 item-changed on the second; nothing written', async () => {
    const { project, path } = await seeded();
    const update = vi.spyOn(ItemsRepo.prototype, 'update').mockResolvedValue(false);
    const response = await decide(path, { command: 'approve', via: 'web' });
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('item-changed');
    expect(update).toHaveBeenCalledTimes(2);
    expect(await countRows('owner_decisions', project.slug)).toBe(0);
  });
});

describe('POST /projects/:slug/items/:key/decisions — who and where', () => {
  it('403 owner-only for a job (the seam), the service identity; 401 without identity', async () => {
    const { project, path } = await seeded();
    const job = await decide(path, { command: 'approve', via: 'web' }, { policyActor: PM });
    expect(job.status).toBe(403);
    expect(await slugOf(job)).toBe('owner-only');
    const service = await sendAsService('POST', `${path}/decisions`, { command: 'approve', via: 'web' });
    expect(service.status).toBe(403);
    expect(await slugOf(service)).toBe('owner-only');
    expect((await sendWithoutIdentity('POST', `${path}/decisions`)).status).toBe(401);
    expect(await countRows('owner_decisions', project.slug)).toBe(0);
  });

  it('404 unknown project and item (also an item key of another project), 409 tracker-not-cut-over, 413', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    const { key } = await seedItem(other);
    const body = { command: 'approve', via: 'web' };
    expect(await slugOf(await send('POST', '/api/v1/projects/nope/items/1/decisions', body))).toBe(
      'project-not-found',
    );
    expect(await slugOf(await send('POST', `/api/v1/projects/${project.slug}/items/7/decisions`, body))).toBe(
      'item-not-found',
    );
    expect(
      await slugOf(await send('POST', `/api/v1/projects/${project.slug}/items/${key}/decisions`, body)),
    ).toBe('item-not-found');
    const github = await seedGitHubProject();
    expect(await slugOf(await send('POST', `/api/v1/projects/${github}/items/1/decisions`, body))).toBe(
      'tracker-not-cut-over',
    );
    const { path } = await seedItem(project);
    expect((await decide(path, { ...body, text: 'x'.repeat(17_000) })).status).toBe(413);
  });

  it('GET …/decisions is no-store and refuses the service identity', async () => {
    const { path } = await seeded();
    await decide(path, { command: 'approve', via: 'web' });
    const response = await send('GET', `${path}/decisions?limit=1`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(((await response.json()) as DecisionListDto).decisions).toHaveLength(1);
    expect(await slugOf(await sendAsService('GET', `${path}/decisions`))).toBe('owner-only');
  });
});
