import asksCreated from '../../../fixtures/tracker/asks.created.json';
import asksList from '../../../fixtures/tracker/asks.list.json';
import commentsCreated from '../../../fixtures/tracker/comments.created.json';
import commentsList from '../../../fixtures/tracker/comments.list.json';
import decisionsList from '../../../fixtures/tracker/decisions.list.json';
import decisionsOtherProject from '../../../fixtures/tracker/decisions.other-project.json';
import decisionsQueryInvalid from '../../../fixtures/tracker/decisions.query-invalid.json';
import inboxJob from '../../../fixtures/tracker/inbox.job.json';
import itemsChanged from '../../../fixtures/tracker/items.changed.json';
import itemsCreated from '../../../fixtures/tracker/items.created.json';
import itemsEvents from '../../../fixtures/tracker/items.events.json';
import itemsGet from '../../../fixtures/tracker/items.get.json';
import itemsList from '../../../fixtures/tracker/items.list.json';
import itemsNotCutOver from '../../../fixtures/tracker/items.not-cut-over.json';
import itemsOtherProject from '../../../fixtures/tracker/items.other-project.json';
import itemsQueueMoved from '../../../fixtures/tracker/items.queue-moved.json';
import itemsStale from '../../../fixtures/tracker/items.stale.json';
import itemsTransitionOwnerOnly from '../../../fixtures/tracker/items.transition-owner-only.json';
import itemsTransitionRole from '../../../fixtures/tracker/items.transition-role.json';
import labelsList from '../../../fixtures/tracker/labels.list.json';
import labelsOwnerOnly from '../../../fixtures/tracker/labels.owner-only.json';
import prLinksCreated from '../../../fixtures/tracker/pr-links.created.json';
import prLinksInvalid from '../../../fixtures/tracker/pr-links.invalid.json';
import prLinksNotHeld from '../../../fixtures/tracker/pr-links.not-held.json';
import requestsPending from '../../../fixtures/tracker/requests.pending.json';
import requestsQueryInvalid from '../../../fixtures/tracker/requests.query-invalid.json';
import sprintsChanged from '../../../fixtures/tracker/sprints.changed.json';
import sprintsCreated from '../../../fixtures/tracker/sprints.created.json';
import sprintsGet from '../../../fixtures/tracker/sprints.get.json';
import sprintsList from '../../../fixtures/tracker/sprints.list.json';
import {
  pullRequestsGitHub,
  seedAsk,
  seedGitHubProject,
  seedItem,
  seedTrackerProject,
  send,
  type SeededProject,
} from '../../testing/tracker-kit';

/*
 * #445: the contract fixtures the plugin's console client is tested against (architect note on #436 §5): one request
 * and its response per file in `apps/api/fixtures/tracker/`, replayed here through the whole app. The plugin's fake
 * server serves the same files, so a route change that alters a response fails here until the fixture changes too —
 * and the fixture diff is what the plugin's contract lock then picks up.
 *
 * A fixture names the project `tc` with key prefix `TC` and its repository `acme/tc`; the spec seeds a fresh
 * project per fixture and maps the two both ways. Volatile values are fixed in the comparison: every `…At` (and event `at`) instant
 * reads `2026-11-12T10:00:00.000Z`, a problem's `instance` reads `request-id`, and row ids (with the `next` cursor)
 * are renumbered 1, 2, … in order of appearance per member family. To update a fixture, run this spec and copy the
 * `actual` it prints into the file's `response`.
 */

interface Fixture {
  readonly route: string;
  readonly as: {
    readonly kind: string;
    readonly role: string;
    readonly items: readonly number[];
    readonly project?: string;
  };
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly ifMatch?: string;
    readonly body?: unknown;
  };
  readonly response: { readonly status: number; readonly body: unknown };
}

const FIXED_AT = '2026-11-12T10:00:00.000Z';

/** `projectSlug`: the project the job belongs to; `pathProject`: the project the request path names instead. */
type Setup = (
  project: SeededProject,
) => Promise<{ readonly projectSlug?: string; readonly pathProject?: SeededProject } | void>;

const seedFeature = (project: SeededProject, title: string, status?: 'approved') =>
  seedItem(project, { title, kind: 'feature', ...(status === undefined ? {} : { status }) });

const seedOne: Setup = async (project) => void (await seedFeature(project, 'Export to CSV'));

const seedSprint: Setup = async (project) => {
  const response = await send('POST', `/api/v1/projects/${project.slug}/sprints`, {
    title: 'Checkout',
    dueOn: '2026-11-19',
  });
  if (response.status !== 201) {
    throw new Error(`seeding a sprint answered ${String(response.status)}`);
  }
};

async function decided(
  project: SeededProject,
  title: string,
  command: 'approve' | 'reject',
  text: string,
): Promise<void> {
  const { path } = await seedItem(project, { title });
  const ask = await seedAsk(path);
  const response = await send('POST', `${path}/decisions`, { command, text, askId: ask.id, via: 'web' });
  if (response.status !== 201) {
    throw new Error(`seeding a decision answered ${String(response.status)}`);
  }
}

const SETUPS: Readonly<Record<string, readonly [Fixture, Setup]>> = {
  'items.list': [
    itemsList,
    async (project) => {
      await seedFeature(project, 'Export to CSV');
      await seedFeature(project, 'Dark mode', 'approved');
    },
  ],
  'items.get': [itemsGet, seedOne],
  'items.created': [itemsCreated, async () => undefined],
  'items.changed': [itemsChanged, seedOne],
  'items.events': [itemsEvents, seedOne],
  'items.queue-moved': [
    itemsQueueMoved,
    async (project) => {
      await seedFeature(project, 'Export to CSV', 'approved');
      await seedFeature(project, 'Dark mode', 'approved');
    },
  ],
  'items.transition-owner-only': [itemsTransitionOwnerOnly, seedOne],
  'items.transition-role': [
    itemsTransitionRole,
    async (project) => {
      await send('POST', `/api/v1/projects/${project.slug}/labels`, { name: 'workflow-change', color: 'b60205' });
      await seedFeature(project, 'Export to CSV');
    },
  ],
  'items.stale': [itemsStale, seedOne],
  'items.other-project': [
    itemsOtherProject,
    async () => ({ projectSlug: (await seedTrackerProject()).slug }),
  ],
  'items.not-cut-over': [
    itemsNotCutOver,
    async (project) => ({
      pathProject: { slug: await seedGitHubProject(), keyPrefix: project.keyPrefix },
    }),
  ],
  'comments.list': [
    commentsList,
    async (project) => {
      const { path } = await seedFeature(project, 'Export to CSV');
      await send('POST', `${path}/comments`, { kind: 'comment', body: 'Which format?' });
    },
  ],
  'comments.created': [commentsCreated, seedOne],
  'asks.list': [
    asksList,
    async (project) => {
      const { path } = await seedFeature(project, 'Export to CSV');
      await seedAsk(path, { ask: 'Ship the beta to the first ten users?', recommended: 'approve' });
    },
  ],
  'asks.created': [asksCreated, seedOne],
  'sprints.list': [sprintsList, seedSprint],
  'sprints.get': [sprintsGet, seedSprint],
  'sprints.created': [sprintsCreated, async () => undefined],
  'sprints.changed': [sprintsChanged, seedSprint],
  'labels.list': [labelsList, async () => undefined],
  'labels.owner-only': [labelsOwnerOnly, async () => undefined],
  'decisions.list': [
    decisionsList,
    async (project) => {
      await decided(project, 'Export to CSV', 'approve', '');
      await decided(project, 'Dark mode', 'reject', 'Not this quarter');
      await decided(project, 'Offline mode', 'reject', 'Too big');
    },
  ],
  'decisions.query-invalid': [decisionsQueryInvalid, async () => undefined],
  'decisions.other-project': [
    decisionsOtherProject,
    async () => ({ projectSlug: (await seedTrackerProject()).slug }),
  ],
  'requests.pending': [
    requestsPending,
    async (project) => {
      const { path } = await seedItem(project, { title: 'Checkout', kind: 'feature', status: 'approved' });
      await send('POST', `${path}/requests`, { kind: 'sprint', target: 'next' });
    },
  ],
  'requests.query-invalid': [requestsQueryInvalid, async () => undefined],
  'pr-links.created': [
    prLinksCreated,
    async (project) =>
      void (await seedItem(project, { title: 'Login', kind: 'feature', status: 'in-progress' })),
  ],
  'pr-links.not-held': [
    prLinksNotHeld,
    async (project) =>
      void (await seedItem(project, { title: 'Login', kind: 'feature', status: 'in-progress' })),
  ],
  'pr-links.invalid': [
    prLinksInvalid,
    async (project) =>
      void (await seedItem(project, { title: 'Login', kind: 'feature', status: 'in-progress' })),
  ],
  'inbox.job': [
    inboxJob,
    async (project) => {
      const { path } = await seedItem(project, { title: 'Ship the beta?' });
      await seedAsk(path, { ask: 'Ship the beta to the first ten users?', recommended: 'approve' });
    },
  ],
};

const ID_FAMILIES: Readonly<Record<string, string>> = { id: 'id', next: 'id' };

function stabilised(value: unknown, ids: Map<string, Map<number, number>>, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stabilised(entry, ids));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([member, entry]) => [
        member,
        stabilised(entry, ids, member),
      ]),
    );
  }
  if (typeof value === 'string' && (key === 'at' || key.endsWith('At'))) {
    return FIXED_AT;
  }
  if (typeof value === 'string' && key === 'instance') {
    return 'request-id';
  }
  if (typeof value === 'number' && (key === 'id' || key === 'next' || key.endsWith('Id'))) {
    const family = ID_FAMILIES[key] ?? key;
    const seen = ids.get(family) ?? new Map<number, number>();
    ids.set(family, seen);
    const renumbered = seen.get(value) ?? seen.size + 1;
    seen.set(value, renumbered);
    return renumbered;
  }
  return value;
}

/** The fixture's text for `project`: the slug `tc` and the prefix `TC` swapped for the seeded ones. */
function toProject(text: string, project: SeededProject): string {
  return text.replaceAll('/tc/', `/${project.slug}/`).replaceAll('TC-', `${project.keyPrefix}-`);
}

function fromProject(text: string, project: SeededProject): string {
  return text.replaceAll(project.slug, 'tc').replaceAll(`${project.keyPrefix}-`, 'TC-');
}

describe('the tracker contract fixtures (#445, #611)', () => {
  it('has a setup for every fixture and a fixture per route the plugin needs', () => {
    const routes = new Set(Object.values(SETUPS).map(([fixture]) => fixture.route));
    expect([...routes].sort()).toEqual([
      'GET /api/v1/projects/:slug/decisions',
      'GET /api/v1/projects/:slug/inbox',
      'GET /api/v1/projects/:slug/items',
      'GET /api/v1/projects/:slug/items/:key',
      'GET /api/v1/projects/:slug/items/:key/asks',
      'GET /api/v1/projects/:slug/items/:key/comments',
      'GET /api/v1/projects/:slug/items/:key/events',
      'GET /api/v1/projects/:slug/labels',
      'GET /api/v1/projects/:slug/requests',
      'GET /api/v1/projects/:slug/sprints',
      'GET /api/v1/projects/:slug/sprints/:number',
      'PATCH /api/v1/projects/:slug/items/:key',
      'PATCH /api/v1/projects/:slug/sprints/:number',
      'POST /api/v1/projects/:slug/items',
      'POST /api/v1/projects/:slug/items/:key/asks',
      'POST /api/v1/projects/:slug/items/:key/comments',
      'POST /api/v1/projects/:slug/items/:key/pr-links',
      'POST /api/v1/projects/:slug/items/:key/queue',
      'POST /api/v1/projects/:slug/labels',
      'POST /api/v1/projects/:slug/sprints',
    ]);
  });

  it.each(Object.entries(SETUPS))('%s answers as the fixture says', async (name, [fixture, setup]) => {
    const project = await seedTrackerProject();
    const seeded = (await setup(project)) ?? {};
    const named = seeded.pathProject ?? project;
    const path = toProject(fixture.request.path, named);
    const body =
      fixture.request.body === undefined
        ? undefined
        : JSON.parse(toProject(JSON.stringify(fixture.request.body), named));
    // GitHub has the pull request a pr-link fixture names, with the fixture's branch (#529).
    const link = body as { number?: unknown; headRef?: unknown } | undefined;
    const { github } = pullRequestsGitHub((number) =>
      number === link?.number && typeof link.headRef === 'string' ? link.headRef : null,
    );
    const response = await send(fixture.request.method as 'GET' | 'POST' | 'PATCH', path, body, {
      github,
      ...(fixture.request.ifMatch === undefined ? {} : { ifMatch: fixture.request.ifMatch }),
      job: {
        role: fixture.as.role,
        items: fixture.as.items,
        ...(seeded.projectSlug === undefined ? {} : { projectSlug: seeded.projectSlug }),
      },
    });
    const text = await response.text();
    const actual = {
      status: response.status,
      body: stabilised(JSON.parse(fromProject(text, named)) as unknown, new Map()),
    };
    if (JSON.stringify(actual) !== JSON.stringify(fixture.response)) {
      console.log(`FIXTURE ${name} ${JSON.stringify(actual)}`);
    }
    expect(actual).toEqual(fixture.response);
  });
});
