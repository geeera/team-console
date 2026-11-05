import { env } from 'cloudflare:test';
import type { CommentDto, CommentListDto, ItemDto, ItemEventListDto } from '@shared/contracts';
import {
  countRows,
  jobActor,
  newKey,
  seedGitHubProject,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #410: comments on tracker items — append-only, authored by the identity, never by the body.

async function seedItem(project: SeededProject): Promise<string> {
  const response = await send('POST', `/api/v1/projects/${project.slug}/items`, {
    title: 'Item',
    kind: 'chore',
  });
  return `/api/v1/projects/${project.slug}/items/${((await response.json()) as ItemDto).key}/comments`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:slug/items/:key/comments', () => {
  it('appends the owner’s comment as typed and records a commented event', async () => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const response = await send('POST', path, { body: '  Ship it\n\n- after QA  ' });
    expect(response.status).toBe(201);
    const comment = (await response.json()) as CommentDto;
    expect(comment).toMatchObject({
      kind: 'comment',
      author: { kind: 'owner', name: 'owner' },
      body: '  Ship it\n\n- after QA  ',
      source: 'console',
      sourceUrl: null,
    });
    const events = (await (
      await send('GET', path.replace(/comments$/, 'events'))
    ).json()) as ItemEventListDto;
    expect(events.events.at(-1)).toMatchObject({ kind: 'commented', after: { commentId: comment.id } });
  });

  it('answers a replayed key with the same comment and writes it once', async () => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const key = newKey();
    const first = await send('POST', path, { body: 'Once' }, { key });
    const again = await send('POST', path, { body: 'Once' }, { key });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('comments', project.slug)).toBe(1);
  });

  it.each([
    [{ body: '' }, 'body'],
    [{ body: ' \n ' }, 'body'],
    [{ body: 'x'.repeat(65_537) }, 'body'],
    [{ body: 'x', kind: 'verdict' }, 'kind'],
    [{ body: 'x', author: 'qa' }, 'body'],
  ])('answers 422 comment-invalid for %j', async (body, field) => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const response = await send('POST', path, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('comment-invalid'), field });
    expect(await countRows('comments', project.slug)).toBe(0);
  });

  it('answers 404 for an unknown item, 409 on a project still on GitHub Issues, 400 without a key', async () => {
    const project = await seedTrackerProject();
    const missing = await send('POST', `/api/v1/projects/${project.slug}/items/9/comments`, { body: 'x' });
    expect(missing.status).toBe(404);
    expect(await slugOf(missing)).toBe('item-not-found');
    const slug = await seedGitHubProject();
    const gated = await send('POST', `/api/v1/projects/${slug}/items/1/comments`, { body: 'x' });
    expect(gated.status).toBe(409);
    expect(await slugOf(gated)).toBe('tracker-not-cut-over');
    const keyless = await send('POST', await seedItem(project), { body: 'x' }, { key: null });
    expect(keyless.status).toBe(400);
  });

  // #444: the owner's decisions are `owner_decisions` rows, so the owner writes comments only.
  it.each(['note', 'decision'])('answers 403 comment-kind to the owner writing a %s', async (kind) => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const response = await send('POST', path, { kind, body: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('comment-kind'),
      reason: kind,
    });
    expect(await countRows('comments', project.slug)).toBe(0);
  });

  it('records a job’s note and team decision under its role and job id, the kind on the commented event', async () => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const architect = jobActor('architect', 'job-arch-3');
    const note = await send('POST', path, { kind: 'note', body: 'Implementation note' }, { job: architect });
    const decision = await send('POST', path, { kind: 'decision', body: 'We ship it' }, { job: architect });
    expect([note.status, decision.status]).toEqual([201, 201]);
    const written = (await decision.json()) as CommentDto;
    expect(written).toMatchObject({ kind: 'decision', author: { kind: 'job', name: 'architect' } });
    // The job id is the token's, kept on the row for the audit; the DTO shows the role only.
    const row = await env.DB.prepare('SELECT job_id FROM comments WHERE id = ?1')
      .bind(written.id)
      .first<{ job_id: string }>();
    expect(row?.job_id).toBe('job-arch-3');
    const events = (await (
      await send('GET', path.replace(/comments$/, 'events'))
    ).json()) as ItemEventListDto;
    expect(events.events.filter((event) => event.kind === 'commented').map((event) => event.after)).toEqual([
      expect.objectContaining({ kind: 'note' }),
      expect.objectContaining({ kind: 'decision' }),
    ]);
  });

  it('answers 403 comment-kind to dev-light writing a team decision; its note is fine', async () => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const light = jobActor('dev-light');
    const refused = await send('POST', path, { kind: 'decision', body: 'x' }, { job: light });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      type: expect.stringContaining('comment-kind'),
      reason: 'decision',
    });
    expect((await send('POST', path, { kind: 'note', body: 'x' }, { job: light })).status).toBe(201);
    expect(await countRows('comments', project.slug)).toBe(1);
  });

  it('has no route to edit or delete a comment', async () => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    const comment = (await (await send('POST', path, { body: 'x' })).json()) as CommentDto;
    const edit = await send(
      'PATCH',
      `${path}/${String(comment.id)}`,
      { body: 'changed' },
      { ifMatch: '"1"' },
    );
    expect(edit.status).toBe(404);
  });
});

describe('GET /projects/:slug/items/:key/comments', () => {
  it('lists oldest first, one page at a time', async () => {
    const project = await seedTrackerProject();
    const path = await seedItem(project);
    for (const body of ['one', 'two', 'three']) {
      await send('POST', path, { body });
    }
    const first = (await (await send('GET', `${path}?limit=2`)).json()) as CommentListDto;
    expect(first.comments.map((comment) => comment.body)).toEqual(['one', 'two']);
    const rest = (await (await send('GET', `${path}?after=${String(first.next)}`)).json()) as CommentListDto;
    expect(rest).toMatchObject({ comments: [{ body: 'three' }], next: null });
    expect((await send('GET', `${path}?limit=500`)).status).toBe(400);
  });
});

describe('the comment routes refuse identities without a policy actor', () => {
  it.each(['GET', 'POST'])(
    '%s answers 401 without an identity and 403 owner-only to the service identity',
    async (method) => {
      const project = await seedTrackerProject();
      const path = await seedItem(project);
      expect((await sendWithoutIdentity(method, path)).status).toBe(401);
      const service = await sendAsService(method, path, { body: 'from CI' });
      expect(service.status).toBe(403);
      expect(await slugOf(service)).toBe('owner-only');
      expect(await countRows('comments', project.slug)).toBe(0);
    },
  );
});
