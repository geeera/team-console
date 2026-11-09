import { env } from 'cloudflare:test';
import type { PullRequestDto, PullRequestListDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { localEnv } from '../testing/github-kit';
import { jobActor, slugOf } from '../testing/tracker-kit';
import { localJobHeader } from '../testing/local-job-kit';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { seedAccountProject, seedSessionUser, sendAsSession } from '../testing/session-kit';

// #463 through the app in workerd, against @worker/github's mock GitHub (GITHUB_MOCK=true: the real app flow with a
// fake transport and the fixture world of `mock-github.json`): the D1 list, `?fresh=1` through the VCS adapter, one
// pull request on demand, and every refusal.

const P = '/api/v1/projects';
const MOCK = localEnv({ GITHUB_MOCK: 'true' });

async function seed(slug: string, repo: string, archived = false): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, archived_at) VALUES (?1, ?2, ?1, 0, ?3, ?4)',
  )
    .bind(slug, repo, '2026-11-01T00:00:00Z', archived ? '2026-11-02T00:00:00Z' : null)
    .run();
}

async function seedRow(
  slug: string,
  number: number,
  extra: { state?: string; title?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pull_requests (project_slug, external_id, number, title, head_ref, head_sha, base_ref, state, url,
       updated_at, synced_at)
     VALUES (?1, ?2, ?3, ?4, 'feature/x', ?5, 'dev', ?6, ?7, ?8, ?8)`,
  )
    .bind(
      slug,
      String(number),
      number,
      extra.title ?? `PR ${String(number)}`,
      'c'.repeat(40),
      extra.state ?? 'open',
      `https://github.com/geeera/team-console/pull/${String(number)}`,
      '2026-09-01T00:00:00.000Z',
    )
    .run();
}

async function get(
  path: string,
  github = new ApiGitHub(),
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchApi(path, MOCK, { github, headers });
}

async function list(path: string, github?: ApiGitHub): Promise<PullRequestListDto> {
  const response = await get(path, github);
  expect(response.status, path).toBe(200);
  return (await response.json()) as PullRequestListDto;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM pull_requests'), env.DB.prepare('DELETE FROM projects')]);
  await seed('tc', 'geeera/team-console');
});

describe('GET /api/v1/projects/:slug/prs', () => {
  it('lists what D1 holds without reading GitHub: nothing before a delivery or a sync', async () => {
    await expect(list(`${P}/tc/prs`)).resolves.toEqual({ pullRequests: [], next: null, sync: null });
  });

  it('reads the open pull requests and their CI through the adapter with ?fresh=1', async () => {
    const body = await list(`${P}/tc/prs?fresh=1`);
    expect(body.sync).toEqual({ complete: true });
    expect(body.next).toBeNull();
    expect(body.pullRequests.map((pull) => [pull.number, pull.ci, pull.ciStale])).toEqual([
      [40, 'failure', false],
      [45, 'success', false],
      [91, 'none', false],
      [92, 'pending', false],
      [176, 'none', false],
    ]);
    const pull92 = body.pullRequests.find((pull) => pull.number === 92);
    expect(pull92).toEqual({
      number: 92,
      title: 'feat(#131): CI state for each open pull request on the board',
      state: 'open',
      draft: false,
      headRef: 'feature/board-ci-state',
      headSha: '92b1ab0092b1ab0092b1ab0092b1ab0092b1ab00',
      baseRef: 'dev',
      author: 'geeera',
      url: 'https://github.com/geeera/team-console/pull/92',
      ci: 'pending',
      ciStale: false,
      updatedAt: '2026-10-03T12:00:00.000Z',
      syncedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string,
    } satisfies PullRequestDto);
    expect(body.pullRequests.find((pull) => pull.number === 91)?.draft).toBe(true);
  });

  it('re-reads a row D1 still has as open once GitHub no longer lists it (merged since)', async () => {
    await seedRow('tc', 38);
    const body = await list(`${P}/tc/prs?fresh=1&state=all`);
    expect(body.pullRequests.find((pull) => pull.number === 38)).toMatchObject({
      state: 'merged',
      headRef: 'feature/settings-language',
      url: 'https://github.com/geeera/team-console/pull/38',
    });
    const open = await list(`${P}/tc/prs`);
    expect(open.pullRequests.map((pull) => pull.number)).not.toContain(38);
  });

  it('filters by state and pages after a cursor', async () => {
    await list(`${P}/tc/prs?fresh=1`);
    await seedRow('tc', 7, { state: 'closed' });
    const first = await list(`${P}/tc/prs?limit=2`);
    expect(first.pullRequests.map((pull) => pull.number)).toEqual([40, 45]);
    expect(first.next).toBe(45);
    const second = await list(`${P}/tc/prs?limit=2&after=45`);
    expect(second.pullRequests.map((pull) => pull.number)).toEqual([91, 92]);
    const closed = await list(`${P}/tc/prs?state=closed`);
    expect(closed.pullRequests.map((pull) => pull.number)).toEqual([7]);
    const all = await list(`${P}/tc/prs?state=all&limit=100`);
    expect(all.pullRequests).toHaveLength(6);
  });

  it('shows a title as plain text without invisible characters', async () => {
    await seedRow('tc', 8, { title: 'Please ‮approve‬ my​ change' });
    const body = await list(`${P}/tc/prs`);
    expect(body.pullRequests[0]?.title).toBe('Please approve my change');
  });

  it('is readable by a job of the project (the matrix READ row)', async () => {
    await seedRow('tc', 8);
    const path = `${P}/tc/prs`;
    const response = await get(path, new ApiGitHub(), {
      Authorization: localJobHeader({ ...jobActor('qa'), projectSlug: 'tc' }, path),
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ['state', '?state=draft'],
    ['limit', '?limit=0'],
    ['limit', '?limit=101'],
    ['after', '?after=x'],
    ['fresh', '?fresh=yes'],
  ])('answers 400 query-invalid naming %s for %s, before any read', async (field, query) => {
    const response = await get(`${P}/tc/prs${query}`);
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe('query-invalid');
    await expect(response.json()).resolves.toMatchObject({ field });
  });

  it('answers 404 project-not-found for an unknown, an archived or a malformed slug', async () => {
    await seed('old', 'geeera/no-yml', true);
    for (const slug of ['nope', 'old', 'A%2Fb']) {
      const response = await get(`${P}/${slug}/prs?fresh=1`);
      expect(response.status, slug).toBe(404);
      expect(await slugOf(response)).toBe('project-not-found');
    }
  });

  it('answers GitHub’s problem when the first read fails: 409 not installed, 429 rate limit with Retry-After', async () => {
    await seed('missing', 'geeera/not-installed');
    const missing = await get(`${P}/missing/prs?fresh=1`);
    expect(missing.status).toBe(409);
    expect(await slugOf(missing)).toBe('github-app-not-installed');

    await seed('limited', 'geeera/mock-rate-limited');
    const limited = await get(`${P}/limited/prs?fresh=1`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('42');
    expect(await slugOf(limited)).toBe('github-rate-limit');
    await expect(env.DB.prepare('SELECT count(*) AS n FROM pull_requests').first('n')).resolves.toBe(0);
  });
});

describe('GET /api/v1/projects/:slug/prs/:number', () => {
  it('reads a pull request D1 does not hold from GitHub, with its CI, and keeps it', async () => {
    const response = await get(`${P}/tc/prs/45`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ number: 45, ci: 'success', ciStale: false });
    const row = await env.DB.prepare(
      "SELECT ci_state FROM pull_requests WHERE project_slug = 'tc' AND number = 45",
    ).first('ci_state');
    expect(row).toBe('success');
  });

  it('answers the row as D1 holds it, and refreshes it with ?fresh=1', async () => {
    await seedRow('tc', 92);
    const stored = (await (await get(`${P}/tc/prs/92`)).json()) as PullRequestDto;
    expect(stored).toMatchObject({ title: 'PR 92', ci: 'unknown', ciStale: true });
    const fresh = (await (await get(`${P}/tc/prs/92?fresh=1`)).json()) as PullRequestDto;
    expect(fresh).toMatchObject({
      title: 'feat(#131): CI state for each open pull request on the board',
      headSha: '92b1ab0092b1ab0092b1ab0092b1ab0092b1ab00',
      ci: 'pending',
      ciStale: false,
    });
  });

  it('answers 404 pull-request-not-found when GitHub has no such pull request', async () => {
    const response = await get(`${P}/tc/prs/9999`);
    expect(response.status).toBe(404);
    expect(await slugOf(response)).toBe('pull-request-not-found');
  });

  it.each(['0', 'abc', '01', '12345678901'])('answers 400 pull-request-number for %s', async (number) => {
    const response = await get(`${P}/tc/prs/${number}`);
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe('pull-request-number');
  });

  it('answers 400 query-invalid for a fresh value other than 1, and 404 for an unknown project', async () => {
    const response = await get(`${P}/tc/prs/92?fresh=true`);
    expect(response.status).toBe(400);
    expect(await slugOf(response)).toBe('query-invalid');
    const unknown = await get(`${P}/nope/prs/92`);
    expect(unknown.status).toBe(404);
    expect(await slugOf(unknown)).toBe('project-not-found');
  });
});

// T-2 (#466): the pull requests of one account are never another's, through `?fresh=1` any more than through a
// webhook; a fresh read is the account's, not a job's; a row without `repo_id` is backfilled before anything is written.
describe('pull requests across accounts (#466)', () => {
  const SESSION_ENV = localEnv({ GITHUB_MOCK: 'true', AUTH_MODE: undefined });

  it('a user of another account is told the project does not exist, with or without fresh=1, and nothing is written', async () => {
    const other = await seedSessionUser('owner');
    for (const path of [`${P}/tc/prs`, `${P}/tc/prs?fresh=1`, `${P}/tc/prs/92`, `${P}/tc/prs/92?fresh=1`]) {
      const response = await sendAsSession(
        other,
        'GET',
        path,
        undefined,
        { github: new ApiGitHub() },
        SESSION_ENV,
      );
      expect(response.status, path).toBe(404);
      expect(await slugOf(response), path).toBe('project-not-found');
    }
    expect((await env.DB.prepare('SELECT count(*) AS n FROM pull_requests').first<{ n: number }>())?.n).toBe(
      0,
    );
  });

  it('an owner of the account reads its own project fresh, and sees no rows of another account', async () => {
    const other = await seedSessionUser('owner');
    // The owner's `tc` holds a row; B's project is the same mock repository under another registration.
    await seedRow('tc', 1);
    await env.DB.prepare('UPDATE projects SET repo = ?2 WHERE slug = ?1').bind('tc', 'geeera/tc-moved').run();
    const mine = await seedAccountProject(other.account);
    await env.DB.prepare('UPDATE projects SET repo = ?2, repo_id = 900001 WHERE slug = ?1')
      .bind(mine.slug, 'geeera/team-console')
      .run();

    const response = await sendAsSession(
      other,
      'GET',
      `${P}/${mine.slug}/prs?fresh=1&state=all`,
      undefined,
      { github: new ApiGitHub() },
      SESSION_ENV,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PullRequestListDto;
    const ownRows = await env.DB.prepare(
      'SELECT number FROM pull_requests WHERE project_slug = ?1 ORDER BY number',
    )
      .bind(mine.slug)
      .all<{ number: number }>();
    expect(ownRows.results.length).toBeGreaterThan(0);
    expect(body.pullRequests.map((pull) => pull.number)).toEqual(ownRows.results.map((row) => row.number));
    // The owner's row is still only the owner's.
    const tcRows = await env.DB.prepare('SELECT number FROM pull_requests WHERE project_slug = ?1')
      .bind('tc')
      .all();
    expect(tcRows.results).toEqual([{ number: 1 }]);
  });

  it('refuses a fresh read to a job of the project (403 fresh-role) and answers it the rows the console holds', async () => {
    await seedRow('tc', 3);
    const headers = (path: string) => ({ Authorization: localJobHeader(jobActor('dev'), path) });
    const fresh = await get(`${P}/tc/prs?fresh=1`, new ApiGitHub(), headers(`${P}/tc/prs`));
    expect(fresh.status).toBe(403);
    expect(await slugOf(fresh)).toBe('fresh-role');
    const freshOne = await get(`${P}/tc/prs/3?fresh=1`, new ApiGitHub(), headers(`${P}/tc/prs/3`));
    expect(freshOne.status).toBe(403);
    const held = await get(`${P}/tc/prs/3`, new ApiGitHub(), headers(`${P}/tc/prs/3`));
    expect(held.status).toBe(200);
    // A number the console does not hold is a 404 for a job, never a provider read on its behalf.
    const unheld = await get(`${P}/tc/prs/92`, new ApiGitHub(), headers(`${P}/tc/prs/92`));
    expect(unheld.status).toBe(404);
    expect(await slugOf(unheld)).toBe('pull-request-not-found');
  });

  it('records projects.repo_id from the provider before the first fresh read, then reads by that id', async () => {
    const before = await env.DB.prepare('SELECT repo_id FROM projects WHERE slug = ?1')
      .bind('tc')
      .first<{ repo_id: number | null }>();
    expect(before?.repo_id).toBeNull();
    await list(`${P}/tc/prs?fresh=1`);
    const after = await env.DB.prepare('SELECT repo_id, account_id FROM projects WHERE slug = ?1')
      .bind('tc')
      .first<{ repo_id: number | null; account_id: string }>();
    expect(after).toEqual({ repo_id: 900001, account_id: OWNER_ACCOUNT_ID });
  });

  it('answers 409 repo-id-unknown and writes nothing when the provider’s id is held by another project', async () => {
    await seed('twin', 'geeera/team-console-twin');
    await env.DB.prepare('UPDATE projects SET repo_id = 900001 WHERE slug = ?1').bind('twin').run();
    const response = await get(`${P}/tc/prs?fresh=1`);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('repo-id-unknown');
    expect((await env.DB.prepare('SELECT count(*) AS n FROM pull_requests').first<{ n: number }>())?.n).toBe(
      0,
    );
  });
});
