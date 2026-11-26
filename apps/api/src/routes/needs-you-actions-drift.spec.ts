import { env } from 'cloudflare:test';
import type { RunnerWorkflowRendering } from '@shared/actions-workflow';
import { isNeedsYouActionsDriftDto, type NeedsYouDto, type NeedsYouProjectDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { SETUP_ORIGIN, renderingFor } from '../testing/actions-setup-kit';
import { json, localEnv, stubGitHub, type StubGitHub } from '../testing/github-kit';
import { seedAccountProject, seedSessionUser, sendAsSession } from '../testing/session-kit';
import { seedTrackerProject } from '../testing/tracker-kit';

// #874: an Actions project's workflow drift on Needs you, from the judgement stored by the readiness check or a
// failed dispatch (migration 0041). One D1 query, no GitHub call.

const CHECKED_AT = '2026-11-20T09:00:00.000Z';

let rendering: RunnerWorkflowRendering;
let github: StubGitHub;

beforeAll(async () => {
  rendering = await renderingFor();
});

beforeEach(() => {
  github = stubGitHub(() => json(500, { message: 'no GitHub call expected' }));
});

afterEach(async () => {
  await env.DB.prepare(
    `UPDATE projects SET archived_at = '2026-11-05T00:00:00Z' WHERE archived_at IS NULL`,
  ).run();
});

interface Stored {
  readonly dispatch?: 'pull' | 'actions';
  readonly status: string | null;
  readonly sha256?: string | null;
  readonly checkedAt?: string | null;
}

async function store(slug: string, stored: Stored): Promise<void> {
  await env.DB.prepare(
    `UPDATE projects SET dispatch = ?2, actions_workflow_status = ?3, actions_workflow_sha256 = ?4,
       actions_workflow_checked_at = ?5 WHERE slug = ?1`,
  )
    .bind(
      slug,
      stored.dispatch ?? 'actions',
      stored.status,
      stored.sha256 === undefined ? rendering.sha256 : stored.sha256,
      stored.checkedAt === undefined ? CHECKED_AT : stored.checkedAt,
    )
    .run();
}

async function needsYou(origin: string | undefined = SETUP_ORIGIN): Promise<NeedsYouDto> {
  const response = await fetchApi('/api/v1/needs-you', localEnv({ CONSOLE_PUBLIC_ORIGIN: origin }), {
    github: new ApiGitHub({ fetch: github.fetch }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as NeedsYouDto;
}

const rowOf = (body: NeedsYouDto, slug: string): NeedsYouProjectDto | undefined =>
  body.projects.find((row) => row.slug === slug);

describe('GET /api/v1/needs-you: the Actions workflow drift (#874)', () => {
  it.each(['missing', 'outdated', 'unsupported', 'modified'] as const)(
    'names a stored %s with when it was checked, and calls GitHub not once',
    async (status) => {
      const { slug } = await seedTrackerProject();
      await store(slug, { status });
      const drift = rowOf(await needsYou(), slug)?.actionsDrift;
      expect(drift).toEqual({ drift: status, checkedAt: CHECKED_AT });
      expect(isNeedsYouActionsDriftDto(drift)).toBe(true);
      expect(github.calls).toEqual([]);
    },
  );

  it('names release drift for a file that matched an earlier rendering, and none for the current one', async () => {
    const earlier = await seedTrackerProject();
    const current = await seedTrackerProject();
    await store(earlier.slug, { status: 'ok', sha256: 'a'.repeat(64) });
    await store(current.slug, { status: 'ok' });
    const body = await needsYou();
    expect(rowOf(body, earlier.slug)?.actionsDrift).toEqual({ drift: 'release', checkedAt: CHECKED_AT });
    expect(Object.hasOwn(rowOf(body, current.slug) ?? {}, 'actionsDrift')).toBe(false);
  });

  it('still names stored drift on a console that cannot render, only no release drift', async () => {
    const modified = await seedTrackerProject();
    const earlier = await seedTrackerProject();
    await store(modified.slug, { status: 'modified' });
    await store(earlier.slug, { status: 'ok', sha256: 'a'.repeat(64) });
    const body = await needsYou('not an origin');
    expect(rowOf(body, modified.slug)?.actionsDrift).toEqual({ drift: 'modified', checkedAt: CHECKED_AT });
    expect(Object.hasOwn(rowOf(body, earlier.slug) ?? {}, 'actionsDrift')).toBe(false);
  });

  it('names nothing for a project on pull, one never checked, or one whose check could not look', async () => {
    const pull = await seedTrackerProject();
    const unchecked = await seedTrackerProject();
    const unknown = await seedTrackerProject();
    await store(pull.slug, { dispatch: 'pull', status: 'modified' });
    await store(unchecked.slug, { status: null, sha256: null, checkedAt: null });
    await store(unknown.slug, { status: 'unknown' });
    const body = await needsYou();
    for (const slug of [pull.slug, unchecked.slug, unknown.slug]) {
      expect(Object.hasOwn(rowOf(body, slug) ?? {}, 'actionsDrift'), slug).toBe(false);
    }
  });

  it('leaves the drift out for a member, who cannot open the owner-only setup page', async () => {
    const owner = await seedSessionUser('owner');
    const member = await seedSessionUser('member');
    await env.DB.prepare(
      'INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(owner.account.id, member.userId, 'member', '2026-11-10T00:00:00.000Z')
      .run();
    const project = await seedAccountProject(owner.account, { tracker: 'console' });
    await store(project.slug, { status: 'modified' });
    const api = new ApiGitHub({ fetch: github.fetch });
    const read = async (user: typeof owner): Promise<NeedsYouProjectDto | undefined> =>
      rowOf(
        (await (
          await sendAsSession(user, 'GET', '/api/v1/needs-you', undefined, { github: api })
        ).json()) as NeedsYouDto,
        project.slug,
      );
    expect((await read(owner))?.actionsDrift).toEqual({ drift: 'modified', checkedAt: CHECKED_AT });
    expect(Object.hasOwn((await read(member)) ?? {}, 'actionsDrift')).toBe(false);
  });
});

describe('the stored judgement (migration 0041)', () => {
  it('refuses a status, a sha256 or a time outside its CHECK', async () => {
    const { slug } = await seedTrackerProject();
    await expect(store(slug, { status: 'wrong' })).rejects.toThrow();
    await expect(store(slug, { status: 'ok', sha256: 'A'.repeat(64) })).rejects.toThrow();
    await expect(store(slug, { status: 'ok', sha256: 'a'.repeat(63) })).rejects.toThrow();
    await expect(store(slug, { status: 'ok', checkedAt: '2026-11-20 09:00:00' })).rejects.toThrow();
  });
});
