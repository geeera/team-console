import { ITEM_STATUSES, type ItemDto, type ItemRequestDto, type ItemStatus } from '@shared/contracts';
import { createApiApp } from '../app';
import {
  countRows,
  jobActor,
  seedAsk,
  seedItem,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
  type SeededProject,
} from '../testing/tracker-kit';
import type { TestJob } from '../testing/local-job-kit';
import { JOB_ROLES, type JobRole } from './job-roles';
import { TRACKER_MATRIX, isTrackerMatrixRoute, type TrackerRoute } from './tracker-matrix';

// #444: the tracker's route matrix, cell by cell — every tracker route × the owner, each job role (the local
// stand-in, through the real auth seam), a job of another project and the service identity. A refusal writes nothing.

type Who = 'owner' | JobRole;
type Expected = { readonly status: number; readonly slug?: string };

const P = '/api/v1/projects';
const EDITORS: readonly string[] = ['pm', 'architect', 'orchestrator'];
const STATUS_MOVERS: readonly string[] = ['dev', 'dev-light', 'dev-heavy', 'qa'];
const DEVELOPERS: readonly string[] = ['dev', 'dev-light', 'dev-heavy'];

const ok = (status: number): Expected => ({ status });
const refused = (slug: string, status = 403): Expected => ({ status, slug });

interface Scenario {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  readonly ifMatch?: string;
  /** The item numbers a job of this scenario holds. */
  readonly items?: readonly number[];
}

interface Row {
  readonly route: TrackerRoute;
  /** A label for a second scenario of the same route (comment kinds). */
  readonly variant?: string;
  readonly setup: (project: SeededProject) => Promise<Scenario>;
  readonly expect: (who: Who) => Expected;
}

async function item(
  project: SeededProject,
  input: Record<string, unknown> = {},
): Promise<{ path: string; number: number }> {
  const { path, key } = await seedItem(project, input);
  return { path, number: Number(key.split('-').at(-1)) };
}

async function sprint(project: SeededProject): Promise<string> {
  const response = await send('POST', `${P}/${project.slug}/sprints`, {});
  if (response.status !== 201) {
    throw new Error(`seeding a sprint answered ${String(response.status)}`);
  }
  return `${P}/${project.slug}/sprints/1`;
}

const reads = (route: TrackerRoute, path: (project: SeededProject) => Promise<string>): Row => ({
  route,
  setup: async (project) => ({ method: 'GET', path: await path(project) }),
  expect: () => ok(200),
});

const ROWS: readonly Row[] = [
  reads(`GET ${P}/:slug/items`, async (project) => `${P}/${project.slug}/items`),
  reads(`GET ${P}/:slug/items/:key`, async (project) => (await item(project)).path),
  reads(`GET ${P}/:slug/items/:key/events`, async (project) => `${(await item(project)).path}/events`),
  reads(`GET ${P}/:slug/items/:key/comments`, async (project) => `${(await item(project)).path}/comments`),
  reads(`GET ${P}/:slug/items/:key/asks`, async (project) => `${(await item(project)).path}/asks`),
  reads(`GET ${P}/:slug/items/:key/decisions`, async (project) => `${(await item(project)).path}/decisions`),
  reads(`GET ${P}/:slug/items/:key/requests`, async (project) => `${(await item(project)).path}/requests`),
  reads(`GET ${P}/:slug/sprints`, async (project) => `${P}/${project.slug}/sprints`),
  reads(`GET ${P}/:slug/sprints/:number`, sprint),
  reads(`GET ${P}/:slug/labels`, async (project) => `${P}/${project.slug}/labels`),
  {
    route: `POST ${P}/:slug/items`,
    setup: async (project) => ({
      method: 'POST',
      path: `${P}/${project.slug}/items`,
      body: { title: 'New', kind: 'chore' },
    }),
    // The transition table: only the editing roles create items.
    expect: (who) => (who === 'owner' || EDITORS.includes(who) ? ok(201) : refused('transition-role')),
  },
  {
    route: `PATCH ${P}/:slug/items/:key`,
    setup: async (project) => {
      const { path, number } = await item(project, { kind: 'feature', status: 'approved' });
      return { method: 'PATCH', path, body: { status: 'in-progress' }, ifMatch: '"1"', items: [number] };
    },
    // dev*/qa move the status of an item they hold; security changes flags only; the rest edit nothing.
    expect: (who) =>
      who === 'owner' || EDITORS.includes(who) || STATUS_MOVERS.includes(who)
        ? ok(200)
        : refused('transition-role'),
  },
  {
    route: `POST ${P}/:slug/items/:key/comments`,
    setup: async (project) => ({
      method: 'POST',
      path: `${(await item(project)).path}/comments`,
      body: { body: 'A comment' },
    }),
    expect: () => ok(201),
  },
  {
    route: `POST ${P}/:slug/items/:key/comments`,
    variant: 'kind: note',
    setup: async (project) => ({
      method: 'POST',
      path: `${(await item(project)).path}/comments`,
      body: { kind: 'note', body: 'A note' },
    }),
    expect: (who) => (who === 'owner' ? refused('comment-kind') : ok(201)),
  },
  {
    route: `POST ${P}/:slug/items/:key/comments`,
    variant: 'kind: decision',
    setup: async (project) => ({
      method: 'POST',
      path: `${(await item(project)).path}/comments`,
      body: { kind: 'decision', body: 'We ship it' },
    }),
    expect: (who) => (who === 'owner' || who === 'dev-light' ? refused('comment-kind') : ok(201)),
  },
  {
    route: `POST ${P}/:slug/sprints`,
    setup: async (project) => ({ method: 'POST', path: `${P}/${project.slug}/sprints`, body: {} }),
    expect: (who) => (who === 'owner' || who === 'pm' ? ok(201) : refused('sprint-role')),
  },
  {
    route: `PATCH ${P}/:slug/sprints/:number`,
    setup: async (project) => ({
      method: 'PATCH',
      path: await sprint(project),
      body: { description: 'Goal' },
    }),
    expect: (who) => (who === 'owner' || who === 'pm' ? ok(200) : refused('sprint-role')),
  },
  {
    route: `POST ${P}/:slug/labels`,
    setup: async (project) => ({
      method: 'POST',
      path: `${P}/${project.slug}/labels`,
      body: { name: 'agent:matrix', color: 'ededed' },
    }),
    expect: (who) => (who === 'owner' ? ok(201) : refused('owner-only')),
  },
  {
    route: `POST ${P}/:slug/items/:key/asks`,
    setup: async (project) => ({
      method: 'POST',
      path: `${(await item(project)).path}/asks`,
      body: { category: 'scope', ask: 'Ship it now?', commands: ['approve', 'reject'] },
    }),
    expect: (who) => (who === 'owner' || DEVELOPERS.includes(who) ? refused('ask-role') : ok(201)),
  },
  {
    route: `POST ${P}/:slug/items/:key/decisions`,
    setup: async (project) => {
      const { path } = await item(project);
      const ask = await seedAsk(path);
      return {
        method: 'POST',
        path: `${path}/decisions`,
        body: { command: 'approve', askId: ask.id, via: 'web' },
      };
    },
    expect: (who) => (who === 'owner' ? ok(201) : refused('owner-only')),
  },
  {
    route: `POST ${P}/:slug/items/:key/requests`,
    setup: async (project) => ({
      method: 'POST',
      path: `${(await item(project, { kind: 'feature', status: 'approved' })).path}/requests`,
      body: { kind: 'sprint', target: 'next' },
    }),
    expect: (who) => (who === 'owner' ? ok(201) : refused('owner-only')),
  },
  {
    route: `POST ${P}/:slug/requests/:id/handled`,
    setup: async (project) => {
      const { path } = await item(project, { kind: 'feature', status: 'approved' });
      const request = (await (
        await send('POST', `${path}/requests`, { kind: 'sprint', target: 'next' })
      ).json()) as ItemRequestDto;
      return {
        method: 'POST',
        path: `${P}/${project.slug}/requests/${String(request.id)}/handled`,
        body: { result: 'applied' },
      };
    },
    expect: (who) => (who === 'pm' ? ok(200) : refused('request-handled-role')),
  },
];

const TABLES = [
  'items',
  'item_events',
  'item_labels',
  'comments',
  'sprints',
  'labels',
  'asks',
  'owner_decisions',
  'item_requests',
] as const;

async function snapshot(slug: string): Promise<number[]> {
  return Promise.all(TABLES.map((table) => countRows(table, slug)));
}

async function sendAs(scenario: Scenario, job?: TestJob): Promise<Response> {
  return send(scenario.method, scenario.path, scenario.body, {
    ...(scenario.ifMatch === undefined ? {} : { ifMatch: scenario.ifMatch }),
    ...(job === undefined ? {} : { job }),
  });
}

async function expectOutcome(response: Response, expected: Expected, label: string): Promise<void> {
  expect(response.status, label).toBe(expected.status);
  if (expected.slug !== undefined) {
    expect(await slugOf(response), label).toBe(expected.slug);
  }
}

const label = (row: Row): string => (row.variant === undefined ? row.route : `${row.route} (${row.variant})`);
const WHO: readonly Who[] = ['owner', ...JOB_ROLES];

describe('the route matrix covers the tracker', () => {
  const trackerRoutes = [
    ...new Set(
      createApiApp()
        .routes.filter(
          (route) =>
            route.method !== 'ALL' &&
            /^\/api\/v1\/projects\/:slug\/(items|sprints|labels|requests\/:id)\b/.test(route.path),
        )
        .map((route) => `${route.method} ${route.path}`),
    ),
  ];

  it('lists every tracker route of the app, and none that does not exist', () => {
    expect(trackerRoutes.length).toBeGreaterThan(0);
    expect([...trackerRoutes].sort()).toEqual(Object.keys(TRACKER_MATRIX).sort());
  });

  it('has a scenario for every row', () => {
    expect([...new Set(ROWS.map((row) => row.route))].sort()).toEqual(Object.keys(TRACKER_MATRIX).sort());
  });

  it('matches a row’s concrete paths, never a longer or another path', () => {
    expect(isTrackerMatrixRoute('GET', '/api/v1/projects/acme/items/TC-1')).toBe(true);
    expect(isTrackerMatrixRoute('GET', '/api/v1/projects/acme/items/TC-1/')).toBe(true);
    expect(isTrackerMatrixRoute('DELETE', '/api/v1/projects/acme/items/TC-1')).toBe(false);
    expect(isTrackerMatrixRoute('GET', '/api/v1/projects/acme/items/TC-1/x')).toBe(false);
    expect(isTrackerMatrixRoute('GET', '/api/v1/projects/acme/inbox')).toBe(false);
    expect(isTrackerMatrixRoute('GET', '/api/v1/projects/acme')).toBe(false);
    expect(isTrackerMatrixRoute('GET', '/api/v1/projects/a/b/items')).toBe(false);
    expect(isTrackerMatrixRoute('POST', '/api/v1/projects/acme/issues/1/answer')).toBe(false);
  });
});

describe.each(ROWS.map((row) => [label(row), row] as const))('%s', (_, row) => {
  it.each(WHO)('as %s', async (who) => {
    const project = await seedTrackerProject();
    const scenario = await row.setup(project);
    const before = await snapshot(project.slug);
    const job = who === 'owner' ? undefined : jobActor(who, `job-${who}`, scenario.items ?? []);
    const expected = row.expect(who);
    await expectOutcome(await sendAs(scenario, job), expected, `${who} on ${label(row)}`);
    if (expected.status >= 400) {
      expect(await snapshot(project.slug), 'a refusal writes nothing').toEqual(before);
    }
  });

  it('answers 404 project-not-found to a job of another project, whatever its role, writing nothing', async () => {
    const project = await seedTrackerProject();
    const other = await seedTrackerProject();
    const scenario = await row.setup(project);
    const before = await snapshot(project.slug);
    for (const role of ['pm', 'orchestrator', 'dev']) {
      const job: TestJob = { ...jobActor(role), items: scenario.items ?? [], projectSlug: other.slug };
      await expectOutcome(
        await sendAs(scenario, job),
        refused('project-not-found', 404),
        `${role} of another project`,
      );
    }
    expect(await snapshot(project.slug)).toEqual(before);
  });

  it('answers 403 owner-only to the service identity and 401 without one, writing nothing', async () => {
    const project = await seedTrackerProject();
    const scenario = await row.setup(project);
    const before = await snapshot(project.slug);
    await expectOutcome(
      await sendAsService(scenario.method, scenario.path, scenario.body),
      refused('owner-only'),
      'service',
    );
    expect((await sendWithoutIdentity(scenario.method, scenario.path)).status).toBe(401);
    expect(await snapshot(project.slug)).toEqual(before);
  });
});

describe('a job of another project cannot tell a missing project from a foreign one', () => {
  it('gets the same 404 for a slug that does not exist', async () => {
    const own = await seedTrackerProject();
    const response = await send('GET', `${P}/no-such-project/items`, undefined, {
      job: { ...jobActor('pm'), projectSlug: own.slug },
    });
    await expectOutcome(response, refused('project-not-found', 404), 'missing project');
  });
});

// R5 over HTTP: the owner-semantic changes stay owner-only for every role, PM and orchestrator included.
describe('R5: owner-only transitions stay owner-only for every role', () => {
  const changes: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['approving a proposed item', { kind: 'feature' }, { status: 'approved' }, 'approve'],
    [
      'approving a design',
      { kind: 'feature', status: 'approved' },
      { addLabels: ['design:approved'] },
      'design-approved',
    ],
    [
      'setting an owner flag',
      { kind: 'feature', status: 'approved' },
      { addLabels: ['owner:scope'] },
      'owner-flag',
    ],
    [
      'closing the demo item',
      { kind: 'chore', status: 'qa', labels: ['team:demo'] },
      { status: 'done' },
      'close-demo',
    ],
  ];

  it.each(changes)(
    '%s is 403 transition-owner-only to every role, and the owner’s to make',
    async (_, seed, body, reason) => {
      const project = await seedTrackerProject();
      const { path, number } = await item(project, seed);
      for (const role of JOB_ROLES) {
        const response = await send('PATCH', path, body, {
          ifMatch: '"1"',
          job: jobActor(role, 'job-r5', [number]),
        });
        expect(response.status, role).toBe(403);
        expect(await response.json(), role).toMatchObject({
          type: expect.stringContaining('transition-owner-only') as unknown,
          reason,
        });
      }
      expect(((await (await send('GET', path)).json()) as ItemDto).version).toBe(1);
      expect((await send('PATCH', path, body, { ifMatch: '"1"' })).status).toBe(200);
    },
  );
});

// R2 over HTTP: a reviewer role never writes state that reads as a verdict.
describe('R2: reviewer roles never write verdict-like state', () => {
  it.each(['qa:changes-requested', 'review-failed', 'tier-up'])(
    '%s is refused to qa, reviewer and security, and left to the orchestrator',
    async (flag) => {
      const project = await seedTrackerProject();
      const { path, number } = await item(project, { kind: 'feature', status: 'in-progress' });
      for (const role of ['qa', 'reviewer', 'security']) {
        const response = await send(
          'PATCH',
          path,
          { addLabels: [flag] },
          { ifMatch: '"1"', job: jobActor(role, 'job-r2', [number]) },
        );
        expect(response.status, role).toBe(403);
        expect(await slugOf(response), role).toBe('transition-role');
      }
      const orchestrator = await send(
        'PATCH',
        path,
        { addLabels: [flag] },
        { ifMatch: '"1"', job: jobActor('orchestrator') },
      );
      expect(orchestrator.status).toBe(200);
    },
  );

  it('gives no reviewer role an owner decision, a request answer or a sprint', async () => {
    const project = await seedTrackerProject();
    const { path } = await item(project);
    const ask = await seedAsk(path);
    for (const role of ['qa', 'reviewer', 'security']) {
      const job = jobActor(role);
      expect(
        await slugOf(
          await send('POST', `${path}/decisions`, { command: 'approve', askId: ask.id, via: 'web' }, { job }),
        ),
      ).toBe('owner-only');
      expect(await slugOf(await send('POST', `${P}/${project.slug}/sprints`, {}, { job }))).toBe(
        'sprint-role',
      );
    }
    expect(await countRows('owner_decisions', project.slug)).toBe(0);
  });
});

describe('a status-moving role and the items it holds', () => {
  it.each(STATUS_MOVERS)('%s moving an item it does not hold gets 403 item-not-held', async (role) => {
    const project = await seedTrackerProject();
    const held = await item(project, { kind: 'feature', status: 'approved' });
    const other = await item(project, { kind: 'feature', status: 'approved' });
    const response = await send(
      'PATCH',
      other.path,
      { status: 'in-progress' },
      { ifMatch: '"1"', job: jobActor(role, 'job-h', [held.number]) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'item-not-held' });
  });

  it('records the move under the job’s role and job id', async () => {
    const project = await seedTrackerProject();
    const { path, number } = await item(project, { kind: 'feature', status: 'approved' });
    expect(
      (
        await send(
          'PATCH',
          path,
          { status: 'in-progress' },
          { ifMatch: '"1"', job: jobActor('dev', 'job-dev-42', [number]) },
        )
      ).status,
    ).toBe(200);
    const events = (await (await send('GET', `${path}/events`)).json()) as {
      events: { kind: string; actor: unknown }[];
    };
    expect(events.events.at(-1)).toMatchObject({ kind: 'status', actor: { kind: 'job', name: 'dev' } });
  });
});

// #452: the owner's scope approval is not one edge. An item leaves `proposed` and reaches `approved` only by the
// owner or an owner decision's effect, so no detour (`proposed → blocked → approved`, a dev moving a held proposed
// item straight to work) skips it. Closing a proposed item as not planned or duplicate stays a job's to make.
describe('#452: no job skips the owner’s approval', () => {
  const NOT_PROPOSED = ITEM_STATUSES.filter((status) => status !== 'proposed');
  const BEFORE_APPROVED = ITEM_STATUSES.filter((status) => status !== 'approved');

  /** An item in `status`, seeded by the owner: its path, number and current version. */
  async function itemIn(
    project: SeededProject,
    status: ItemStatus,
  ): Promise<{ path: string; number: number; version: number }> {
    const seeded = await item(project, { kind: 'feature', status: status === 'done' ? 'qa' : status });
    if (status !== 'done') {
      return { ...seeded, version: 1 };
    }
    const closing = await send('PATCH', seeded.path, { status: 'done' }, { ifMatch: '"1"' });
    if (closing.status !== 200) {
      throw new Error(`seeding a done item answered ${String(closing.status)}`);
    }
    return { ...seeded, version: ((await closing.json()) as ItemDto).version };
  }

  async function expectOwnerOnly(response: Response, label: string): Promise<void> {
    expect(response.status, label).toBe(403);
    expect(await slugOf(response), label).toBe('transition-owner-only');
  }

  const leaving = JOB_ROLES.flatMap((role) => NOT_PROPOSED.map((status) => [role, status] as const));
  it.each(leaving)('%s moving a held proposed item to %s gets 403, writing nothing', async (role, status) => {
    const project = await seedTrackerProject();
    const { path, number } = await itemIn(project, 'proposed');
    const before = await snapshot(project.slug);
    await expectOwnerOnly(
      await send('PATCH', path, { status }, { ifMatch: '"1"', job: jobActor(role, `job-${role}`, [number]) }),
      `${role}: proposed → ${status}`,
    );
    expect(await snapshot(project.slug), 'a refusal writes nothing').toEqual(before);
  });

  const reaching = JOB_ROLES.flatMap((role) => BEFORE_APPROVED.map((status) => [role, status] as const));
  it.each(reaching)(
    '%s moving a held %s item to approved gets 403, writing nothing',
    async (role, status) => {
      const project = await seedTrackerProject();
      const { path, number, version } = await itemIn(project, status);
      const before = await snapshot(project.slug);
      await expectOwnerOnly(
        await send(
          'PATCH',
          path,
          { status: 'approved' },
          { ifMatch: `"${String(version)}"`, job: jobActor(role, `job-${role}`, [number]) },
        ),
        `${role}: ${status} → approved`,
      );
      expect(await snapshot(project.slug), 'a refusal writes nothing').toEqual(before);
    },
  );

  // A new item is the same decision: created past `proposed`, it would be workable without the owner.
  const creating = JOB_ROLES.flatMap((role) =>
    NOT_PROPOSED.filter((status) => status !== 'done').map((status) => [role, status] as const),
  );
  it.each(creating)('%s creating an item as %s gets 403, writing nothing', async (role, status) => {
    const project = await seedTrackerProject();
    const before = await snapshot(project.slug);
    await expectOwnerOnly(
      await send(
        'POST',
        `${P}/${project.slug}/items`,
        { title: 'New', kind: 'feature', status },
        { job: jobActor(role) },
      ),
      `${role}: new item as ${status}`,
    );
    expect(await snapshot(project.slug), 'a refusal writes nothing').toEqual(before);
  });

  it.each(['not-planned', 'duplicate'])(
    'leaves closing a proposed item as %s to the editing roles',
    async (closedReason) => {
      const project = await seedTrackerProject();
      for (const role of EDITORS) {
        const { path } = await itemIn(project, 'proposed');
        const response = await send(
          'PATCH',
          path,
          { state: 'closed', closedReason },
          { ifMatch: '"1"', job: jobActor(role) },
        );
        expect(response.status, role).toBe(200);
        expect(await response.json(), role).toMatchObject({ status: 'proposed', closedReason });
      }
    },
  );

  it('keeps the owner’s own path proposed → blocked → approved', async () => {
    const project = await seedTrackerProject();
    const { path } = await itemIn(project, 'proposed');
    expect((await send('PATCH', path, { status: 'blocked' }, { ifMatch: '"1"' })).status).toBe(200);
    const approved = await send('PATCH', path, { status: 'approved' }, { ifMatch: '"2"' });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: 'approved' });
  });

  it('keeps the owner decision’s effect: approve moves a proposed item to approved', async () => {
    const project = await seedTrackerProject();
    const { path } = await item(project);
    const ask = await seedAsk(path);
    expect(
      (await send('POST', `${path}/decisions`, { command: 'approve', askId: ask.id, via: 'web' })).status,
    ).toBe(201);
    expect(((await (await send('GET', path)).json()) as ItemDto).status).toBe('approved');
  });

  it('lets a holding dev take a blocked item back to work', async () => {
    const project = await seedTrackerProject();
    const { path, number } = await itemIn(project, 'blocked');
    const response = await send(
      'PATCH',
      path,
      { status: 'in-progress' },
      { ifMatch: '"1"', job: jobActor('dev', 'job-dev', [number]) },
    );
    expect(response.status).toBe(200);
  });
});

// Security review of #458: the release decision closes a proposed demo item as `done` without approving it. The
// approval is a recorded fact (`items.approved_at`), so the status alone no longer lets a job reopen it into work.
describe('#452: an item the owner closed without approving stays out of work', () => {
  /** The repro: a pm flags a proposed item `team:demo`, the owner answers the release; the item is now done. */
  async function released(
    project: SeededProject,
  ): Promise<{ path: string; number: number; version: number }> {
    const { path, number } = await item(project, { kind: 'chore' });
    const flagging = await send(
      'PATCH',
      path,
      { addLabels: ['team:demo'] },
      { ifMatch: '"1"', job: jobActor('pm') },
    );
    expect(flagging.status).toBe(200);
    const decision = await send('POST', `${path}/decisions`, {
      command: 'no-go',
      text: 'Not now',
      via: 'web',
    });
    expect(decision.status).toBe(201);
    const closed = (await (await send('GET', path)).json()) as ItemDto;
    expect(closed).toMatchObject({ status: 'done', closedReason: 'done' });
    return { path, number, version: closed.version };
  }

  async function expectRefused(response: Response, reason: string, label: string): Promise<void> {
    expect(response.status, label).toBe(403);
    expect(await response.json(), label).toMatchObject({
      type: expect.stringContaining('transition-owner-only') as unknown,
      reason,
    });
  }

  const reopening = JOB_ROLES.flatMap((role) =>
    (['in-progress', 'qa', 'blocked', 'approved'] as const).map((status) => [role, status] as const),
  );
  it.each(reopening)('%s moving the released item to %s gets 403, writing nothing', async (role, status) => {
    const project = await seedTrackerProject();
    const { path, number, version } = await released(project);
    const before = await snapshot(project.slug);
    await expectRefused(
      await send(
        'PATCH',
        path,
        { status },
        { ifMatch: `"${String(version)}"`, job: jobActor(role, `job-${role}`, [number]) },
      ),
      status === 'approved' ? 'approve' : 'not-approved',
      `${role}: done → ${status}`,
    );
    expect(await snapshot(project.slug), 'a refusal writes nothing').toEqual(before);
  });

  it.each(JOB_ROLES)('%s removing team:demo from the closed item gets 403, writing nothing', async (role) => {
    const project = await seedTrackerProject();
    const { path, number, version } = await released(project);
    const before = await snapshot(project.slug);
    await expectRefused(
      await send(
        'PATCH',
        path,
        { removeLabels: ['team:demo'] },
        { ifMatch: `"${String(version)}"`, job: jobActor(role, `job-${role}`, [number]) },
      ),
      'demo-flag',
      `${role}: remove team:demo`,
    );
    expect(await snapshot(project.slug), 'a refusal writes nothing').toEqual(before);
  });

  it('lets the owner reopen the released item into work, which records the approval', async () => {
    const project = await seedTrackerProject();
    const { path, number, version } = await released(project);
    const owner = await send('PATCH', path, { status: 'in-progress' }, { ifMatch: `"${String(version)}"` });
    expect(owner.status).toBe(200);
    const dev = await send(
      'PATCH',
      path,
      { status: 'qa' },
      { ifMatch: `"${String(version + 1)}"`, job: jobActor('dev', 'job-dev', [number]) },
    );
    expect(dev.status).toBe(200);
  });

  // An approved item that was closed is reopened by the same roles as before #452.
  it.each(JOB_ROLES)('%s reopening an approved, done item into work is judged as before', async (role) => {
    const project = await seedTrackerProject();
    const { path, number } = await item(project, { kind: 'feature', status: 'qa' });
    expect((await send('PATCH', path, { status: 'done' }, { ifMatch: '"1"' })).status).toBe(200);
    const response = await send(
      'PATCH',
      path,
      { status: 'in-progress' },
      { ifMatch: '"2"', job: jobActor(role, `job-${role}`, [number]) },
    );
    if (EDITORS.includes(role) || STATUS_MOVERS.includes(role)) {
      expect(response.status, role).toBe(200);
      expect(await response.json(), role).toMatchObject({ status: 'in-progress', state: 'open' });
    } else {
      expect(response.status, role).toBe(403);
      expect(await slugOf(response), role).toBe('transition-role');
    }
  });
});
