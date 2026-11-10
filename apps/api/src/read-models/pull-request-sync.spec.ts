import { env } from 'cloudflare:test';
import type { PullRequestListDto } from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { json, localEnv, stubGitHub, type GitHubCall, type ReadHandler } from '../testing/github-kit';
import { slugOf } from '../testing/tracker-kit';

// #481 against a scripted GitHub behind the real app flow: the sync's incomplete paths (a later list page, the page
// cap, the re-read cap, a CI read that fails or runs out of budget), and the read cache that keeps a loop on a
// missing number or a failing first page from spending the installation's shared quota.

const P = '/api/v1/projects';
const REPO = '/repos/geeera/team-console';
const REPO_ID = 900001;

function shaOf(number: number): string {
  return number.toString(16).padStart(40, '0');
}

function pullOf(number: number, state: 'open' | 'closed' = 'open'): Record<string, unknown> {
  return {
    id: 7_000_000 + number,
    number,
    title: `PR ${String(number)}`,
    state,
    draft: false,
    merged_at: null,
    updated_at: '2026-11-10T10:00:00Z',
    head: {
      ref: `feature/${String(number)}`,
      sha: shaOf(number),
      repo: { full_name: 'geeera/team-console' },
    },
    base: { ref: 'dev' },
    user: { login: 'geeera' },
  };
}

const REPOSITORY = { id: REPO_ID, full_name: 'geeera/team-console', default_branch: 'dev', private: false };
const CHECKS_PASSED = {
  total_count: 1,
  check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
};

interface World {
  /** One list page by its number; `null` for a 502. */
  readonly page?: (page: number) => { items: unknown[]; hasNext: boolean } | null;
  /** One pull request by its number; `null` for a 404, `'fail'` for a 502. */
  readonly pull?: (number: number) => unknown;
  /** The check runs of a head; `null` for a 502. */
  readonly checks?: (sha: string) => unknown;
}

function handlerOf(world: World): ReadHandler {
  return (call: GitHubCall) => {
    const path = call.url.pathname;
    if (path === REPO) {
      return json(200, REPOSITORY);
    }
    if (path === `${REPO}/pulls`) {
      const page = Number(call.url.searchParams.get('page') ?? '1');
      const read = world.page === undefined ? { items: [], hasNext: false } : world.page(page);
      if (read === null) {
        return json(502, { message: 'Server Error' });
      }
      const next = new URL(call.url.href);
      next.searchParams.set('page', String(page + 1));
      return json(200, read.items, read.hasNext ? { link: `<${next.href}>; rel="next"` } : {});
    }
    const pull = /^\/repos\/geeera\/team-console\/pulls\/(\d+)$/.exec(path);
    if (pull?.[1] !== undefined) {
      const found = world.pull?.(Number(pull[1])) ?? null;
      if (found === 'fail') {
        return json(502, { message: 'Server Error' });
      }
      return found === null ? json(404, { message: 'Not Found' }) : json(200, found);
    }
    const checks = /^\/repos\/geeera\/team-console\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
    if (checks?.[1] !== undefined) {
      const found = world.checks === undefined ? CHECKS_PASSED : world.checks(checks[1]);
      return found === null ? json(502, { message: 'Server Error' }) : json(200, found);
    }
    return json(404, { message: 'Not Found' });
  };
}

function setup(world: World) {
  const stub = stubGitHub(handlerOf(world));
  const github = new ApiGitHub({ fetch: stub.fetch });
  const send = (path: string) => fetchApi(path, localEnv(), { github });
  const reads = (pattern: RegExp) =>
    stub.reads().filter((call) => pattern.test(`${call.url.pathname}${call.url.search}`));
  return { send, reads };
}

async function syncOf(response: Response): Promise<PullRequestListDto> {
  expect(response.status).toBe(200);
  return (await response.json()) as PullRequestListDto;
}

async function seedOpenRow(number: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pull_requests (project_slug, external_id, number, title, head_ref, head_sha, base_ref, state, url,
       updated_at, synced_at)
     VALUES ('tc', ?1, ?2, ?3, 'feature/x', ?4, 'dev', 'open', ?5, ?6, ?6)`,
  )
    .bind(
      String(7_000_000 + number),
      number,
      `PR ${String(number)}`,
      shaOf(number),
      `https://github.com/geeera/team-console/pull/${String(number)}`,
      '2026-11-01T00:00:00.000Z',
    )
    .run();
}

async function stateOf(number: number): Promise<{ state: string; ci_stale: number } | null> {
  return env.DB.prepare("SELECT state, ci_stale FROM pull_requests WHERE project_slug = 'tc' AND number = ?1")
    .bind(number)
    .first<{ state: string; ci_stale: number }>();
}

const LIST_READ = /\/pulls\?/;
const ONE_READ = /\/pulls\/\d+$/;
const CI_READ = /\/check-runs\?/;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM pull_requests'), env.DB.prepare('DELETE FROM projects')]);
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, repo_id) VALUES (?1, ?2, ?1, 0, ?3, ?4)',
  )
    .bind('tc', 'geeera/team-console', '2026-11-01T00:00:00Z', REPO_ID)
    .run();
});

describe('pull request sync, incomplete (#481 item 6)', () => {
  it('is incomplete when a later list page fails, keeps the first page, and re-reads no unlisted row', async () => {
    await seedOpenRow(50);
    const { send, reads } = setup({
      page: (page) => (page === 1 ? { items: [pullOf(1)], hasNext: true } : null),
    });
    const body = await syncOf(await send(`${P}/tc/prs?fresh=1`));
    expect(body.sync).toEqual({ complete: false });
    expect(body.pullRequests.map((pull) => pull.number)).toEqual([1, 50]);
    expect(reads(LIST_READ)).toHaveLength(2);
    // Not listed on a list known to be partial is not "closed since": row 50 is never re-read.
    expect(reads(ONE_READ)).toHaveLength(0);
    await expect(stateOf(50)).resolves.toMatchObject({ state: 'open' });
  });

  it('stops at the 3-page cap and says so', async () => {
    const { send, reads } = setup({ page: (page) => ({ items: [pullOf(page)], hasNext: true }) });
    const body = await syncOf(await send(`${P}/tc/prs?fresh=1`));
    expect(body.sync).toEqual({ complete: false });
    expect(body.pullRequests.map((pull) => pull.number)).toEqual([1, 2, 3]);
    expect(reads(LIST_READ).map((call) => call.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(reads(ONE_READ)).toHaveLength(0);
  });

  it('re-reads at most 10 rows the list no longer shows, leaving the rest open and the sync incomplete', async () => {
    const vanished = Array.from({ length: 12 }, (_, index) => 100 + index);
    for (const number of vanished) {
      await seedOpenRow(number);
    }
    const { send, reads } = setup({ pull: (number) => pullOf(number, 'closed') });
    const body = await syncOf(await send(`${P}/tc/prs?fresh=1&state=all&limit=100`));
    expect(body.sync).toEqual({ complete: false });
    expect(reads(ONE_READ)).toHaveLength(10);
    const states = await Promise.all(vanished.map(async (number) => (await stateOf(number))?.state));
    expect(states.filter((state) => state === 'closed')).toHaveLength(10);
    expect(states.filter((state) => state === 'open')).toHaveLength(2);
  });

  it('is incomplete when a CI read fails, and the head stays stale', async () => {
    const { send, reads } = setup({
      page: () => ({ items: [pullOf(1), pullOf(2)], hasNext: false }),
      checks: (sha) => (sha === shaOf(1) ? null : CHECKS_PASSED),
    });
    const body = await syncOf(await send(`${P}/tc/prs?fresh=1`));
    expect(body.sync).toEqual({ complete: false });
    expect(reads(CI_READ)).toHaveLength(2);
    await expect(stateOf(1)).resolves.toMatchObject({ ci_stale: 1 });
    await expect(stateOf(2)).resolves.toMatchObject({ ci_stale: 0 });
  });

  it('is incomplete when the budget runs out before every head’s CI is read', async () => {
    const open = Array.from({ length: 40 }, (_, index) => pullOf(index + 1));
    const { send, reads } = setup({ page: () => ({ items: open, hasNext: false }) });
    const body = await syncOf(await send(`${P}/tc/prs?fresh=1&limit=100`));
    expect(body.sync).toEqual({ complete: false });
    expect(body.pullRequests).toHaveLength(40);
    // 40 = token 2 (installation lookup + mint) + repository 1 + list 1 + 36 CI reads; the 37th is never sent.
    expect(reads(CI_READ)).toHaveLength(36);
    const stale = await env.DB.prepare(
      "SELECT count(*) AS n FROM pull_requests WHERE project_slug = 'tc' AND ci_stale = 1",
    ).first<{ n: number }>();
    expect(stale?.n).toBe(4);
  });

  it('is complete when every page, re-read and CI read succeeds', async () => {
    await seedOpenRow(60);
    const { send } = setup({
      page: () => ({ items: [pullOf(1)], hasNext: false }),
      pull: (number) => pullOf(number, 'closed'),
    });
    const body = await syncOf(await send(`${P}/tc/prs?fresh=1&state=all`));
    expect(body.sync).toEqual({ complete: true });
    await expect(stateOf(60)).resolves.toMatchObject({ state: 'closed' });
  });
});

describe('provider reads through the read cache (#481 item 1)', () => {
  it('reads a number GitHub does not have once per TTL, fresh or not', async () => {
    const { send, reads } = setup({});
    for (const path of [`${P}/tc/prs/9999`, `${P}/tc/prs/9999`, `${P}/tc/prs/9999?fresh=1`]) {
      const response = await send(path);
      expect(response.status, path).toBe(404);
      expect(await slugOf(response), path).toBe('pull-request-not-found');
    }
    expect(reads(/\/pulls\/9999$/)).toHaveLength(1);
    // Another number is another read.
    expect((await send(`${P}/tc/prs/9998`)).status).toBe(404);
    expect(reads(ONE_READ)).toHaveLength(2);
  });

  it('reads a missing number again once a delivery bumped the project’s epoch', async () => {
    const { send, reads } = setup({});
    expect((await send(`${P}/tc/prs/9999`)).status).toBe(404);
    await env.DB.prepare("UPDATE projects SET cache_epoch = cache_epoch + 1 WHERE slug = 'tc'").run();
    expect((await send(`${P}/tc/prs/9999`)).status).toBe(404);
    expect(reads(/\/pulls\/9999$/)).toHaveLength(2);
  });

  it('answers a failed first list page from the cache until the TTL ends, with the same problem', async () => {
    const { send, reads } = setup({ page: () => null });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await send(`${P}/tc/prs?fresh=1`);
      expect(response.status).toBe(502);
      expect(await slugOf(response)).toBe('github-unavailable');
    }
    expect(reads(LIST_READ)).toHaveLength(1);
  });

  it('answers a failed single read from the cache too', async () => {
    const { send, reads } = setup({ pull: () => 'fail' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await send(`${P}/tc/prs/5`);
      expect(response.status).toBe(502);
      expect(await slugOf(response)).toBe('github-unavailable');
    }
    expect(reads(/\/pulls\/5$/)).toHaveLength(1);
  });
});
