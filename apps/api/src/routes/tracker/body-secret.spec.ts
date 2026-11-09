import type { ItemRequestDto } from '@shared/contracts';
import {
  PM,
  countRows,
  jobActor,
  seedItem,
  seedTrackerProject,
  send,
  slugOf,
  type SeededProject,
} from '../../testing/tracker-kit';

// #462 (ADR 0008 row 2-0, #446 decision 5): the free text a job writes never carries a secret shape — 422
// `body-secret` naming the member and the kind, never the value, writing nothing. The owner's own text is not judged.

const P = '/api/v1/projects';
// Assembled at run time so the repository's secret scan never sees a token-shaped literal.
const GITHUB_TOKEN = ['gh', 's_', 'A1b2'.repeat(9)].join('');
const PRIVATE_KEY = [
  '-----BEGIN ',
  'OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----',
].join('');
const leak = (secret: string): string => `Checked the deploy with ${secret} and it works.`;

const TABLES = ['items', 'item_events', 'comments', 'sprints', 'asks', 'item_requests'] as const;

async function snapshot(slug: string): Promise<number[]> {
  return Promise.all(TABLES.map((table) => countRows(table, slug)));
}

async function expectBodySecret(response: Response, field: string, kind: string): Promise<void> {
  expect(response.status).toBe(422);
  expect(await slugOf(response)).toBe('body-secret');
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ field, kind });
  expect(JSON.stringify(body)).not.toContain(GITHUB_TOKEN);
}

interface Case {
  readonly name: string;
  readonly field: string;
  /** The request a job sends; `text` is put where the case says. */
  readonly request: (
    project: SeededProject,
    text: string,
  ) => Promise<{ method: 'POST' | 'PATCH'; path: string; body: unknown; ifMatch?: string; items?: number[] }>;
  readonly role: string;
}

const CASES: readonly Case[] = [
  {
    name: 'an item title',
    field: 'title',
    role: 'pm',
    request: async (project, text) => ({
      method: 'POST',
      path: `${P}/${project.slug}/items`,
      body: { title: text.slice(0, 200), kind: 'chore' },
    }),
  },
  {
    name: 'an item body',
    field: 'body',
    role: 'architect',
    request: async (project, text) => ({
      method: 'POST',
      path: `${P}/${project.slug}/items`,
      body: { title: 'Fine', kind: 'chore', body: text },
    }),
  },
  {
    name: 'an item body edit',
    field: 'body',
    role: 'orchestrator',
    request: async (project, text) => ({
      method: 'PATCH',
      path: (await seedItem(project)).path,
      body: { body: text },
      ifMatch: '"1"',
    }),
  },
  {
    name: 'an item title edit',
    field: 'title',
    role: 'pm',
    request: async (project, text) => ({
      method: 'PATCH',
      path: (await seedItem(project)).path,
      body: { title: text.slice(0, 200) },
      ifMatch: '"1"',
    }),
  },
  {
    name: 'a comment',
    field: 'body',
    role: 'dev',
    request: async (project, text) => ({
      method: 'POST',
      path: `${(await seedItem(project)).path}/comments`,
      body: { kind: 'note', body: text },
    }),
  },
  {
    name: 'an ask',
    field: 'ask',
    role: 'pm',
    request: async (project, text) => ({
      method: 'POST',
      path: `${(await seedItem(project)).path}/asks`,
      body: { category: 'scope', ask: text, commands: ['approve', 'reject'] },
    }),
  },
  {
    name: 'a new sprint’s description',
    field: 'description',
    role: 'pm',
    request: async (project, text) => ({
      method: 'POST',
      path: `${P}/${project.slug}/sprints`,
      body: { description: text },
    }),
  },
  {
    name: 'a sprint description edit',
    field: 'description',
    role: 'pm',
    request: async (project, text) => {
      expect((await send('POST', `${P}/${project.slug}/sprints`, {})).status).toBe(201);
      return { method: 'PATCH', path: `${P}/${project.slug}/sprints/1`, body: { description: text } };
    },
  },
  {
    name: 'the PM’s answer to a request',
    field: 'reason',
    role: 'pm',
    request: async (project, text) => {
      const { path } = await seedItem(project, { kind: 'feature', status: 'approved' });
      const request = (await (
        await send('POST', `${path}/requests`, { kind: 'sprint', target: 'next' })
      ).json()) as ItemRequestDto;
      return {
        method: 'POST',
        path: `${P}/${project.slug}/requests/${String(request.id)}/handled`,
        body: { result: 'declined', reason: text },
      };
    },
  },
];

describe.each(CASES.map((each) => [each.name, each] as const))(
  'a job writing a secret into %s',
  (_, each) => {
    it.each([
      ['a GitHub token', GITHUB_TOKEN, 'github-token'],
      ['a private key', PRIVATE_KEY, 'private-key'],
    ])('is refused 422 body-secret for %s, writing nothing', async (__, secret, kind) => {
      const project = await seedTrackerProject();
      const request = await each.request(project, leak(secret));
      const before = await snapshot(project.slug);
      const response = await send(request.method, request.path, request.body, {
        ...(request.ifMatch === undefined ? {} : { ifMatch: request.ifMatch }),
        job: jobActor(each.role, 'job-secret', [1]),
      });
      await expectBodySecret(response, each.field, kind);
      expect(await snapshot(project.slug)).toEqual(before);
    });

    it('is written when the text carries no secret', async () => {
      const project = await seedTrackerProject();
      const request = await each.request(
        project,
        'Checked the deploy with the installation token; it works.',
      );
      const response = await send(request.method, request.path, request.body, {
        ...(request.ifMatch === undefined ? {} : { ifMatch: request.ifMatch }),
        job: jobActor(each.role, 'job-clean', [1]),
      });
      expect(response.status).toBeLessThan(300);
    });
  },
);

describe('a secret split by invisible characters', () => {
  // Every Default_Ignorable_Code_Point the security review of #474 found slipping, and the earlier ones.
  it.each([
    ['a zero-width space', '\u200b'],
    ['a zero-width joiner', '\u200d'],
    ['a soft hyphen', '\u00ad'],
    ['variation selector 16', '\ufe0f'],
    ['a combining grapheme joiner', '\u034f'],
    ['a Mongolian vowel separator', '\u180e'],
    ['a halfwidth Hangul filler', '\uffa0'],
  ])('is still refused when %s hides it', async (_, invisible) => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const hidden = `${GITHUB_TOKEN.slice(0, 10)}${invisible}${GITHUB_TOKEN.slice(10)}`;
    await expectBodySecret(
      await send('POST', `${path}/comments`, { kind: 'note', body: leak(hidden) }, { job: PM }),
      'body',
      'github-token',
    );
  });
});

// Security review of #474: the sprint title is job-written, never editable afterwards and not scrubbable.
describe('a sprint title', () => {
  it('is refused 422 body-secret when the PM names a sprint with a token, writing nothing', async () => {
    const project = await seedTrackerProject();
    const before = await snapshot(project.slug);
    const response = await send(
      'POST',
      `${P}/${project.slug}/sprints`,
      { title: GITHUB_TOKEN, description: 'Goal' },
      { job: PM },
    );
    await expectBodySecret(response, 'title', 'github-token');
    expect(await snapshot(project.slug)).toEqual(before);
    expect(
      (
        await send(
          'POST',
          `${P}/${project.slug}/sprints`,
          { title: 'Payments', description: 'Goal' },
          { job: PM },
        )
      ).status,
    ).toBe(201);
  });
});

describe('the order of the checks', () => {
  it('answers a comment kind the role may not write with 403 comment-kind before judging its text', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const response = await send(
      'POST',
      `${path}/comments`,
      { kind: 'decision', body: leak(GITHUB_TOKEN) },
      { job: jobActor('dev-light') },
    );
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('comment-kind');
  });

  it('answers an item change the role may not make with the transition table’s 403 before judging its text', async () => {
    const project = await seedTrackerProject();
    const created = await send(
      'POST',
      `${P}/${project.slug}/items`,
      { title: 'New', kind: 'chore', body: leak(GITHUB_TOKEN) },
      { job: jobActor('dev') },
    );
    expect(created.status).toBe(403);
    expect(await slugOf(created)).toBe('transition-role');
    const approved = await seedItem(project, { kind: 'feature', status: 'approved' });
    const edited = await send(
      'PATCH',
      approved.path,
      { body: leak(GITHUB_TOKEN) },
      { ifMatch: '"1"', job: jobActor('pm') },
    );
    expect(edited.status).toBe(403);
    expect(await slugOf(edited)).toBe('transition-owner-only');
  });
});

describe('the owner’s own text', () => {
  it('is not judged: the owner may paste what a job may not', async () => {
    const project = await seedTrackerProject();
    const created = await send('POST', `${P}/${project.slug}/items`, {
      title: 'Rotate the token',
      kind: 'chore',
      body: leak(GITHUB_TOKEN),
    });
    expect(created.status).toBe(201);
    const { path } = await seedItem(project);
    expect((await send('POST', `${path}/comments`, { body: leak(GITHUB_TOKEN) })).status).toBe(201);
  });

  it('keeps the refusal on the key: the job may send the cleaned text under the same Idempotency-Key', async () => {
    const project = await seedTrackerProject();
    const { path } = await seedItem(project);
    const key = `secret-retry-${crypto.randomUUID()}`;
    const refused = await send('POST', `${path}/comments`, { body: leak(GITHUB_TOKEN) }, { key, job: PM });
    expect(refused.status).toBe(422);
    const fixed = await send('POST', `${path}/comments`, { body: 'Checked the deploy.' }, { key, job: PM });
    expect(fixed.status).toBe(201);
  });
});
