import { env } from 'cloudflare:test';
import type { ItemDto, ItemEventListDto, ItemRequestDto, ItemRequestListDto } from '@shared/contracts';
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

// #434 §4: the owner records a wish for the PM; only the PM job answers it, and the record names the job.

const NEXT = { kind: 'sprint', target: 'next' };

async function seedRequest(): Promise<{ slug: string; path: string; request: ItemRequestDto }> {
  const project = await seedTrackerProject();
  const { path } = await seedItem(project, { kind: 'feature', status: 'approved' });
  const response = await send('POST', `${path}/requests`, NEXT);
  return { slug: project.slug, path, request: (await response.json()) as ItemRequestDto };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:slug/items/:key/requests', () => {
  it('records the owner’s request with a requested event and changes nothing else', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project, { kind: 'feature', status: 'approved' });
    const response = await send('POST', `${path}/requests`, { kind: 'priority', direction: 'up' });
    expect(response.status).toBe(201);
    const request = (await response.json()) as ItemRequestDto;
    expect(request).toMatchObject({
      request: { kind: 'priority', direction: 'up' },
      result: null,
      reason: null,
      handledAt: null,
    });
    const item = (await (await send('GET', path)).json()) as ItemDto;
    expect(item).toMatchObject({ version: 1, sprint: null, status: 'approved' });
    const events = ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
    expect(events.at(-1)).toMatchObject({
      kind: 'requested',
      actor: { kind: 'owner', name: 'owner' },
      after: { requestId: request.id, request: { kind: 'priority', direction: 'up' } },
    });
    const listed = (await (await send('GET', `${path}/requests`)).json()) as ItemRequestListDto;
    expect(listed).toEqual({ requests: [request], next: null });
  });

  it('answers a replayed key with the same request, written once', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const key = newKey();
    const first = await send('POST', `${path}/requests`, NEXT, { key });
    const again = await send('POST', `${path}/requests`, NEXT, { key });
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect(await countRows('item_requests', project.slug)).toBe(1);
  });

  it.each([
    [{ kind: 'label', target: 'next' }, 'kind'],
    [{ kind: 'sprint', target: 'later' }, 'target'],
    [{ kind: 'priority', direction: 'left' }, 'direction'],
    [{ ...NEXT, requestedAt: '2026-01-01' }, 'requestedAt'],
    [{ ...NEXT, itemId: 1 }, 'itemId'],
    [{ ...NEXT, ownerSaid: 'please' }, 'body'],
  ])('422 request-invalid on %j (field %s)', async (body, field) => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const response = await send('POST', `${path}/requests`, body);
    expect(await slugOf(response)).toBe('request-invalid');
    expect(await response.json()).toMatchObject({ field });
    expect(await countRows('item_requests', project.slug)).toBe(0);
  });

  it('409 item-closed on a closed item', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project, { kind: 'chore', status: 'approved' });
    await send('PATCH', path, { status: 'done' }, { ifMatch: '"1"' });
    const response = await send('POST', `${path}/requests`, NEXT);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('item-closed');
  });

  it('403 owner-only for a job and the service identity, 401 without identity, 404/409 by project', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    expect(await slugOf(await send('POST', `${path}/requests`, NEXT, { policyActor: PM }))).toBe(
      'owner-only',
    );
    expect(await slugOf(await sendAsService('POST', `${path}/requests`, NEXT))).toBe('owner-only');
    expect((await sendWithoutIdentity('POST', `${path}/requests`)).status).toBe(401);
    expect(await slugOf(await send('POST', '/api/v1/projects/nope/items/1/requests', NEXT))).toBe(
      'project-not-found',
    );
    const github = await seedGitHubProject();
    expect(await slugOf(await send('POST', `/api/v1/projects/${github}/items/1/requests`, NEXT))).toBe(
      'tracker-not-cut-over',
    );
    expect(await countRows('item_requests', project.slug)).toBe(0);
  });
});

describe('POST /projects/:slug/requests/:id/handled', () => {
  it('records the PM’s answer once, with the job from the actor and a handled event', async () => {
    const { slug, path, request } = await seedRequest();
    const response = await send(
      'POST',
      `/api/v1/projects/${slug}/requests/${String(request.id)}/handled`,
      { result: 'declined', reason: 'Freeze' },
      { policyActor: jobActor('pm', 'job-pm-7') },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: request.id, result: 'declined', reason: 'Freeze' });
    const row = await env.DB.prepare('SELECT handled_by_job_id FROM item_requests WHERE id = ?1')
      .bind(request.id)
      .first<{ handled_by_job_id: string }>();
    expect(row?.handled_by_job_id).toBe('job-pm-7');
    const events = ((await (await send('GET', `${path}/events`)).json()) as ItemEventListDto).events;
    expect(events.at(-1)).toMatchObject({
      kind: 'handled',
      actor: { kind: 'job', name: 'pm' },
      after: { requestId: request.id, result: 'declined' },
    });

    const again = await send(
      'POST',
      `/api/v1/projects/${slug}/requests/${String(request.id)}/handled`,
      { result: 'applied' },
      { policyActor: PM },
    );
    expect(again.status).toBe(409);
    expect(await slugOf(again)).toBe('request-handled');
  });

  it('403 request-handled-role for the owner and any role but pm; 403 owner-only for the service', async () => {
    const { slug, request } = await seedRequest();
    const handledPath = `/api/v1/projects/${slug}/requests/${String(request.id)}/handled`;
    const owner = await send('POST', handledPath, { result: 'applied' });
    expect(owner.status).toBe(403);
    expect(await slugOf(owner)).toBe('request-handled-role');
    for (const role of ['architect', 'orchestrator', 'dev']) {
      expect(
        await slugOf(await send('POST', handledPath, { result: 'applied' }, { policyActor: jobActor(role) })),
      ).toBe('request-handled-role');
    }
    expect(await slugOf(await sendAsService('POST', handledPath, { result: 'applied' }))).toBe('owner-only');
  });

  it('404 for another project’s request or a malformed id; 422 on the body, including a forged job id', async () => {
    const { slug, request } = await seedRequest();
    const other = await seedTrackerProject();
    const inOther = await send(
      'POST',
      `/api/v1/projects/${other.slug}/requests/${String(request.id)}/handled`,
      { result: 'applied' },
      { policyActor: PM },
    );
    expect(inOther.status).toBe(404);
    expect(await slugOf(inOther)).toBe('request-not-found');
    expect(
      (
        await send(
          'POST',
          `/api/v1/projects/${slug}/requests/x1/handled`,
          { result: 'applied' },
          { policyActor: PM },
        )
      ).status,
    ).toBe(404);
    const handledPath = `/api/v1/projects/${slug}/requests/${String(request.id)}/handled`;
    for (const [body, field] of [
      [{ result: 'pending' }, 'result'],
      [{ result: 'applied', handledByJobId: 'job-forged' }, 'handledByJobId'],
      [{ result: 'applied', reason: 'x'.repeat(1025) }, 'reason'],
    ] as const) {
      const response = await send('POST', handledPath, body, { policyActor: PM });
      expect(await slugOf(response)).toBe('request-invalid');
      expect(await response.json()).toMatchObject({ field });
    }
  });
});
