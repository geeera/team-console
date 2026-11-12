import type { ItemRequestDto, ProjectDecisionListDto, ProjectRequestListDto } from '@shared/contracts';
import {
  PM,
  jobActor,
  seedAsk,
  seedGitHubProject,
  seedItem,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #445: the project-wide feeds the plugin reads — `GET …/decisions` (`backlog reversals`, `demo-page decisions`)
// and `GET …/requests?state=` (`backlog requests`). Reads only: every actor of the project, a job of another one 404.

const P = '/api/v1/projects';

async function decide(project: SeededProject, command: 'approve' | 'reject', text = ''): Promise<string> {
  const { path, key } = await seedItem(project);
  const ask = await seedAsk(path);
  const response = await send('POST', `${path}/decisions`, { command, text, askId: ask.id, via: 'web' });
  expect(response.status).toBe(201);
  return key;
}

async function request(project: SeededProject, body: Record<string, unknown>): Promise<ItemRequestDto> {
  const { path } = await seedItem(project, { kind: 'feature', status: 'approved', title: 'Checkout' });
  const response = await send('POST', `${path}/requests`, body);
  expect(response.status).toBe(201);
  return (await response.json()) as ItemRequestDto;
}

describe('GET /projects/:slug/decisions', () => {
  it('lists the project’s decisions oldest first with their item, to the owner and any job role', async () => {
    const project = await seedTrackerProject();
    const first = await decide(project, 'approve');
    const second = await decide(project, 'reject', 'Not now');
    await decide(await seedTrackerProject(), 'reject', 'Elsewhere');
    const path = `${P}/${project.slug}/decisions`;
    const owner = await send('GET', path);
    expect(owner.status).toBe(200);
    expect(owner.headers.get('Cache-Control')).toBe('no-store');
    const body = (await owner.json()) as ProjectDecisionListDto;
    expect(body.next).toBeNull();
    expect(body.decisions.map((d) => [d.item.key, d.command, d.text])).toEqual([
      [first, 'approve', ''],
      [second, 'reject', 'Not now'],
    ]);
    for (const role of ['pm', 'dev', 'qa']) {
      const job = await send('GET', path, undefined, { job: jobActor(role) });
      expect(job.status, role).toBe(200);
      expect(await job.json(), role).toEqual(body);
    }
  });

  it('filters by command and instant, and pages with the cursor', async () => {
    const project = await seedTrackerProject();
    await decide(project, 'approve');
    const rejected = await decide(project, 'reject', 'No');
    await decide(project, 'approve');
    const path = `${P}/${project.slug}/decisions`;
    const rejects = (await (await send('GET', `${path}?command=reject`)).json()) as ProjectDecisionListDto;
    expect(rejects.decisions.map((d) => d.item.key)).toEqual([rejected]);

    const page = (await (await send('GET', `${path}?limit=2`)).json()) as ProjectDecisionListDto;
    expect(page.decisions).toHaveLength(2);
    expect(page.next).toBe(page.decisions[1]?.id);
    const rest = (await (
      await send('GET', `${path}?limit=2&after=${String(page.next)}`)
    ).json()) as ProjectDecisionListDto;
    expect(rest).toMatchObject({ next: null });
    expect(rest.decisions).toHaveLength(1);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(await (await send('GET', `${path}?since=${future}`)).json()).toEqual({
      decisions: [],
      next: null,
    });
    const past = '2020-01-01T00:00:00Z';
    expect(
      ((await (await send('GET', `${path}?since=${past}`)).json()) as ProjectDecisionListDto).decisions,
    ).toHaveLength(3);
  });

  it.each([
    ['since=yesterday', 'since'],
    ['since=2026-11-12', 'since'],
    ['since=2026-11-12T10:00:00%2B02:00', 'since'],
    ['command=resume%27--', 'command'],
    ['command=APPROVE', 'command'],
    ['limit=101', 'limit'],
    ['limit=0', 'limit'],
    ['after=-1', 'after'],
  ])('400 query-invalid on ?%s (field %s)', async (query, field) => {
    const project = await seedTrackerProject();
    const response = await send('GET', `${P}/${project.slug}/decisions?${query}`);
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe('query-invalid');
    expect(await response.json()).toMatchObject({ field });
  });

  it('401 without identity, 403 for the service, 404 for a job of another project and a missing project', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    const path = `${P}/${project.slug}/decisions`;
    expect((await sendWithoutIdentity('GET', path)).status).toBe(401);
    expect(await slugOf(await sendAsService('GET', path))).toBe('owner-only');
    const foreign = await send('GET', path, undefined, { job: { ...PM, projectSlug: other.slug } });
    expect(foreign.status).toBe(404);
    expect(await slugOf(foreign)).toBe('project-not-found');
    expect(await slugOf(await send('GET', `${P}/no-such-project/decisions`))).toBe('project-not-found');
  });

  it('answers an empty feed for a project still on GitHub Issues', async () => {
    const slug = await seedGitHubProject();
    expect(await (await send('GET', `${P}/${slug}/decisions`)).json()).toEqual({ decisions: [], next: null });
  });
});

describe('GET /projects/:slug/requests?state=', () => {
  it('lists the newest request per item by state, with the item, to the owner and any job role', async () => {
    const project = await seedTrackerProject();
    const pending = await request(project, { kind: 'sprint', target: 'next' });
    const answered = await request(project, { kind: 'priority', direction: 'up' });
    const handled = await send(
      'POST',
      `${P}/${project.slug}/requests/${String(answered.id)}/handled`,
      { result: 'declined', reason: 'Freeze' },
      { job: PM },
    );
    expect(handled.status).toBe(200);
    const path = `${P}/${project.slug}/requests`;

    const owner = await send('GET', `${path}?state=pending`);
    expect(owner.status).toBe(200);
    expect(owner.headers.get('Cache-Control')).toBe('no-store');
    const body = (await owner.json()) as ProjectRequestListDto;
    expect(body).toEqual({
      requests: [
        {
          ...pending,
          item: {
            key: `${project.keyPrefix}-1`,
            number: 1,
            title: 'Checkout',
            state: 'open',
          },
        },
      ],
      next: null,
    });
    const job = await send('GET', `${path}?state=pending`, undefined, { job: jobActor('dev') });
    expect(await job.json()).toEqual(body);

    const done = (await (await send('GET', `${path}?state=handled`)).json()) as ProjectRequestListDto;
    expect(done.requests.map((r) => [r.id, r.result, r.reason])).toEqual([
      [answered.id, 'declined', 'Freeze'],
    ]);
    const all = (await (await send('GET', `${path}?state=all&limit=1`)).json()) as ProjectRequestListDto;
    expect(all.requests.map((r) => r.id)).toEqual([pending.id]);
    expect(all.next).toBe(pending.id);
  });

  it('lists only the newest request of an item: a newer wish replaces the one answered', async () => {
    const project = await seedTrackerProject();
    const first = await request(project, { kind: 'sprint', target: 'next' });
    await send(
      'POST',
      `${P}/${project.slug}/requests/${String(first.id)}/handled`,
      { result: 'applied' },
      { job: PM },
    );
    const again = await send('POST', `${P}/${project.slug}/items/1/requests`, {
      kind: 'sprint',
      target: 'current',
    });
    const newer = (await again.json()) as ItemRequestDto;
    const path = `${P}/${project.slug}/requests`;
    const pending = (await (await send('GET', `${path}?state=pending`)).json()) as ProjectRequestListDto;
    expect(pending.requests.map((r) => r.id)).toEqual([newer.id]);
    expect(await (await send('GET', `${path}?state=handled`)).json()).toEqual({ requests: [], next: null });
  });

  it.each([
    ['state=', 'state'],
    ['state=open', 'state'],
    ['state=pending&limit=500', 'limit'],
    ['state=pending&after=x', 'after'],
  ])('400 query-invalid on ?%s (field %s)', async (query, field) => {
    const project = await seedTrackerProject();
    const response = await send('GET', `${P}/${project.slug}/requests?${query}`);
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe('query-invalid');
    expect(await response.json()).toMatchObject({ field });
  });

  it('401 without identity, 403 for the service, 404 for a job of another project, and the item title as data', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    const path = `${P}/${project.slug}/requests?state=pending`;
    expect((await sendWithoutIdentity('GET', path)).status).toBe(401);
    expect(await slugOf(await sendAsService('GET', path))).toBe('owner-only');
    const foreign = await send('GET', path, undefined, { job: { ...PM, projectSlug: other.slug } });
    expect(foreign.status).toBe(404);
    expect(await slugOf(foreign)).toBe('project-not-found');
    // Another project's requests never leak into this one's list.
    await request(other, { kind: 'sprint', target: 'next' });
    expect(await (await send('GET', path)).json()).toEqual({ requests: [], next: null });
  });

  it('refuses a job the GitHub list without ?state=, before GitHub is asked', async () => {
    const project = await seedTrackerProject();
    const response = await send('GET', `${P}/${project.slug}/requests`, undefined, { job: PM });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
  });

  it('marks a request on an item closed since', async () => {
    const project = await seedTrackerProject();
    await request(project, { kind: 'sprint', target: 'next' });
    const closing = await send(
      'PATCH',
      `${P}/${project.slug}/items/1`,
      { state: 'closed', closedReason: 'not-planned' },
      { ifMatch: '"1"' },
    );
    expect(closing.status).toBe(200);
    const listed = (await (
      await send('GET', `${P}/${project.slug}/requests?state=pending`)
    ).json()) as ProjectRequestListDto;
    expect(listed.requests[0]?.item.state).toBe('closed');
  });
});
