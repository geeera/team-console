import type { LabelListDto } from '@shared/contracts';
import { LABELS_SEED } from '@worker/db';
import {
  countRows,
  newKey,
  seedGitHubProject,
  seedTrackerProject,
  send,
  sendAsService,
  sendWithoutIdentity,
  slugOf,
} from '../../testing/tracker-kit';

// #410: a project's label set — the plugin's builtin labels plus the owner's own flags.

const labelsPath = (slug: string): string => `/api/v1/projects/${slug}/labels`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /projects/:slug/labels', () => {
  it('lists the builtin labels seeded at the switch, then the owner’s', async () => {
    const project = await seedTrackerProject();
    await send('POST', labelsPath(project.slug), {
      name: 'agent:dev',
      color: 'ededed',
      description: 'Dev agent',
    });
    const { labels } = (await (await send('GET', labelsPath(project.slug))).json()) as LabelListDto;
    expect(labels).toHaveLength(LABELS_SEED.length + 1);
    expect(labels.find((label) => label.name === 'status:qa')).toMatchObject({ builtin: true });
    expect(labels.at(-1)).toEqual({
      name: 'agent:dev',
      color: 'ededed',
      description: 'Dev agent',
      builtin: false,
    });
  });

  it('lists none for a project still on GitHub Issues, 404 for an unknown one', async () => {
    expect(await (await send('GET', labelsPath(await seedGitHubProject()))).json()).toEqual({ labels: [] });
    expect((await send('GET', labelsPath('nope'))).status).toBe(404);
  });
});

describe('POST /projects/:slug/labels', () => {
  it('creates a custom flag an item can then carry', async () => {
    const project = await seedTrackerProject();
    const response = await send('POST', labelsPath(project.slug), {
      name: 'workflow-change',
      color: 'b60205',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      name: 'workflow-change',
      color: 'b60205',
      description: '',
      builtin: false,
    });
    const item = await send('POST', `/api/v1/projects/${project.slug}/items`, {
      title: 'CI change',
      kind: 'chore',
      labels: ['workflow-change'],
    });
    expect(item.status).toBe(201);
  });

  it('answers a replayed key with the label and 409 label-exists for a name the project has', async () => {
    const project = await seedTrackerProject();
    const key = newKey();
    const body = { name: 'agent:qa', color: 'c2e0c6' };
    expect((await send('POST', labelsPath(project.slug), body, { key })).status).toBe(201);
    const again = await send('POST', labelsPath(project.slug), body, { key });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    for (const name of ['agent:qa', 'security']) {
      const taken = await send('POST', labelsPath(project.slug), { name, color: '000000' });
      expect(taken.status).toBe(409);
      expect(await slugOf(taken)).toBe('label-exists');
    }
    expect(await countRows('labels', project.slug)).toBe(LABELS_SEED.length + 1);
  });

  it.each([
    [{ name: 'tier:huge', color: 'ededed' }, 'name'],
    [{ name: 'Agent', color: 'ededed' }, 'name'],
    [{ name: 'x', color: 'EDEDED' }, 'color'],
    [{ name: 'x', color: 'ededed', description: 'x'.repeat(101) }, 'description'],
  ])('answers 422 label-invalid for %j', async (body, field) => {
    const project = await seedTrackerProject();
    const response = await send('POST', labelsPath(project.slug), body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('label-invalid'), field });
  });

  it('answers 409 tracker-not-cut-over and 413 for a body over 4 KB', async () => {
    const gated = await send('POST', labelsPath(await seedGitHubProject()), { name: 'x', color: 'ededed' });
    expect(gated.status).toBe(409);
    expect(await slugOf(gated)).toBe('tracker-not-cut-over');
    const project = await seedTrackerProject();
    const big = await send('POST', labelsPath(project.slug), {
      name: 'x',
      color: 'ededed',
      description: 'x'.repeat(5000),
    });
    expect(big.status).toBe(413);
  });
});

describe('the label routes are the owner’s', () => {
  it.each(['GET', 'POST'])(
    '%s answers 401 without an identity and 403 owner-only to the service identity',
    async (method) => {
      const project = await seedTrackerProject();
      expect((await sendWithoutIdentity(method, labelsPath(project.slug))).status).toBe(401);
      const service = await sendAsService(method, labelsPath(project.slug), { name: 'ci', color: 'ededed' });
      expect(service.status).toBe(403);
      expect(await slugOf(service)).toBe('owner-only');
      expect(await countRows('labels', project.slug)).toBe(LABELS_SEED.length);
    },
  );
});
