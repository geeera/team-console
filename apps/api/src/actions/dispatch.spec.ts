import { env } from 'cloudflare:test';
import {
  OWNER_ACCOUNT_ID,
  isProblemDetails,
  isProjectDispatchDto,
  problemSlugOf,
  type JobDto,
} from '@shared/contracts';
import { createLogger } from '@worker/core';
import { AccountsRepo } from '@worker/db';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { saveAccessSource, type ActionsProject } from '../testing/actions-oidc-kit';
import {
  INSTALLATION_ID,
  TOKEN_SENTINEL,
  json,
  localEnv,
  stubGitHub,
  type GitHubCall,
  type StubGitHub,
} from '../testing/github-kit';
import { seedTrackerProject } from '../testing/tracker-kit';
import { sweepQueue } from './sweep';

// #670 (#573 sub-issue 3): the owner's switch to GitHub Actions and the console's `workflow_dispatch` per job, with
// #695 item 4 (the default branch comes from GitHub) and #706 (no Actions path for a subscription project).

/** An installation whose mint the scripted GitHub answers itself (stubGitHub mints for INSTALLATION_ID only). */
const SCRIPTED_INSTALLATION = 778;
/** An installation linked to another account (the two-account case). */
const FOREIGN_INSTALLATION = 779;
const ACCOUNT_B = '01M6YSNJ00000000000000DSB2';

const DISPATCHES = /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/team-console-runner\.yml\/dispatches$/;

interface World {
  /** The repository read's `default_branch`; changed to model a rename. */
  defaultBranch: string;
  /** The `id` GitHub answers for the registered name. */
  repoId: number | null;
  /** What `POST …/access_tokens` of SCRIPTED_INSTALLATION answers. */
  scriptedMint: (call: GitHubCall) => Response;
  /** What the dispatch POST answers. */
  dispatch: () => Response;
}

interface Fixture {
  readonly slug: string;
  readonly repo: string;
  readonly repoId: number;
  readonly world: World;
  readonly stub: StubGitHub;
  readonly github: ApiGitHub;
}

async function linkInstallation(accountId: string, installationId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_at)
     SELECT ?1, 'github', ?2, 'acme', '2026-11-01T00:00:00.000Z'
     WHERE NOT EXISTS (SELECT 1 FROM installations WHERE provider = 'github' AND installation_id = ?2 AND unlinked_at IS NULL)`,
  )
    .bind(accountId, String(installationId))
    .run();
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, created_at) SELECT ?1, 'ds-b', 'B', '2026-11-01T00:00:00.000Z'
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?1)`,
  )
    .bind(ACCOUNT_B)
    .run();
  await linkInstallation(OWNER_ACCOUNT_ID, INSTALLATION_ID);
  await linkInstallation(OWNER_ACCOUNT_ID, SCRIPTED_INSTALLATION);
  await linkInstallation(ACCOUNT_B, FOREIGN_INSTALLATION);
});

/** A console-tracker project of the owner's account with a recorded repository id, an installation, an API key. */
async function seedProject(
  options: { installationId?: number; source?: 'api_key' | 'subscription' } = {},
): Promise<Fixture> {
  const { slug } = await seedTrackerProject();
  const row = await env.DB.prepare(`SELECT repo, repo_id FROM projects WHERE slug = ?1`)
    .bind(slug)
    .first<{ repo: string; repo_id: number }>();
  if (row === null) {
    throw new Error('seeded project missing');
  }
  await env.DB.prepare(`UPDATE projects SET installation_id = ?2 WHERE slug = ?1`)
    .bind(slug, options.installationId ?? INSTALLATION_ID)
    .run();
  if ((options.source ?? 'api_key') === 'api_key') {
    const project: ActionsProject = { slug, accountId: OWNER_ACCOUNT_ID, repoId: row.repo_id, repo: row.repo, defaultBranch: 'trunk' };
    expect(await saveAccessSource(project, 'api_key', 0)).toBe('saved');
  }
  const world: World = {
    defaultBranch: 'trunk',
    repoId: row.repo_id,
    scriptedMint: () => json(422, { message: 'The permissions requested are not granted to this installation.' }),
    dispatch: () => new Response(null, { status: 204 }),
  };
  const stub = stubGitHub((call) => {
    if (call.method === 'GET' && call.url.pathname === `/repos/${row.repo}`) {
      return world.repoId === null
        ? json(404, { message: 'Not Found' })
        : json(200, { id: world.repoId, full_name: row.repo, default_branch: world.defaultBranch, private: true });
    }
    if (call.method === 'POST' && call.url.pathname === `/app/installations/${String(SCRIPTED_INSTALLATION)}/access_tokens`) {
      return world.scriptedMint(call);
    }
    if (call.method === 'POST' && DISPATCHES.test(call.url.pathname)) {
      return world.dispatch();
    }
    if (call.method === 'DELETE' && call.url.pathname === '/installation/token') {
      return new Response(null, { status: 204 });
    }
    return json(404, { message: 'Not Found' });
  });
  return { slug, repo: row.repo, repoId: row.repo_id, world, stub, github: new ApiGitHub({ fetch: stub.fetch }) };
}

async function call(
  fixture: Fixture,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
  logs?: string[],
): Promise<Response> {
  return fetchApi(path, localEnv(), {
    method,
    github: fixture.github,
    headers: method === 'GET' ? {} : { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(logs === undefined ? {} : { logSink: (line: string) => logs.push(line) }),
  });
}

const switchTo = (fixture: Fixture, dispatch: string, logs?: string[]): Promise<Response> =>
  call(fixture, 'PUT', `/api/v1/projects/${fixture.slug}/dispatch`, { dispatch }, logs);

async function runNow(fixture: Fixture, logs?: string[]): Promise<JobDto> {
  const response = await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/jobs`, { kind: 'slot-dev' }, logs);
  expect(response.status).toBe(201);
  return (await response.json()) as JobDto;
}

async function problemSlug(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

async function jobRow(id: string) {
  return env.DB.prepare(`SELECT state, dispatch, dispatched_at, result FROM jobs WHERE id = ?1`)
    .bind(id)
    .first<{ state: string; dispatch: string; dispatched_at: string | null; result: string | null }>();
}

const dispatchCalls = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter((entry) => entry.method === 'POST' && DISPATCHES.test(entry.url.pathname));
const actionsMints = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter((entry) => entry.url.pathname.endsWith('/access_tokens') && (entry.body ?? '').includes('repository_ids'));

describe('PUT /api/v1/projects/:slug/dispatch', () => {
  it('switches to actions with the default branch GitHub names, audited as project.dispatch-changed', async () => {
    const fixture = await seedProject();
    const response = await switchTo(fixture, 'actions');
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isProjectDispatchDto(body)).toBe(true);
    expect(body).toEqual({ dispatch: 'actions', defaultBranch: 'trunk' });

    const read = await call(fixture, 'GET', `/api/v1/projects/${fixture.slug}/dispatch`);
    await expect(read.json()).resolves.toEqual({ dispatch: 'actions', defaultBranch: 'trunk' });
    const audit = await env.DB.prepare(
      `SELECT actor_kind, details FROM audit_events WHERE kind = 'project.dispatch-changed' AND target = ?1`,
    )
      .bind(fixture.slug)
      .first<{ actor_kind: string; details: string }>();
    expect(audit?.actor_kind).toBe('user');
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({ from: 'pull', to: 'actions' });

    expect((await switchTo(fixture, 'pull')).status).toBe(200);
    expect(await call(fixture, 'GET', `/api/v1/projects/${fixture.slug}/dispatch`).then(async (r) => r.json())).toEqual({
      dispatch: 'pull',
      defaultBranch: 'trunk',
    });
  });

  it('never takes the default branch from the request (#695 item 4)', async () => {
    const fixture = await seedProject();
    const response = await call(fixture, 'PUT', `/api/v1/projects/${fixture.slug}/dispatch`, {
      dispatch: 'actions',
      defaultBranch: 'attacker-branch',
    });
    expect(response.status).toBe(422);
    expect(await problemSlug(response)).toBe('dispatch-invalid');
    const row = await env.DB.prepare(`SELECT dispatch, default_branch FROM projects WHERE slug = ?1`)
      .bind(fixture.slug)
      .first<{ dispatch: string; default_branch: string | null }>();
    expect(row).toEqual({ dispatch: 'pull', default_branch: null });
  });

  it('refuses actions when GitHub names another repository under the registered name', async () => {
    const fixture = await seedProject();
    fixture.world.repoId = fixture.repoId + 1;
    const response = await switchTo(fixture, 'actions');
    expect(response.status).toBe(422);
    expect(await problemSlug(response)).toBe('dispatch-repository-unverified');
  });

  it('refuses actions for a subscription project inside its UPDATE: 422 access-source-hosted (#706)', async () => {
    const fixture = await seedProject({ source: 'subscription' });
    const response = await switchTo(fixture, 'actions');
    expect(response.status).toBe(422);
    expect(await problemSlug(response)).toBe('access-source-hosted');
    const row = await env.DB.prepare(`SELECT dispatch FROM projects WHERE slug = ?1`).bind(fixture.slug).first<{ dispatch: string }>();
    expect(row?.dispatch).toBe('pull');
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'project.dispatch-changed' AND target = ?1`)
      .bind(fixture.slug)
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it.each([
    ['pinned', { mode: 'pinned', runner: '01M6YSNJ0000000000000RUNR1' }],
    ['failover', { mode: 'failover', preferred: '01M6YSNJ0000000000000RUNR1', fallback: ['01M6YSNJ0000000000000RUNR2'], offline_after_seconds: 300 }],
  ])('refuses actions while placement is %s (#695 item 2), and admits it under any', async (_mode, policy) => {
    const fixture = await seedProject();
    await env.DB.prepare(`UPDATE projects SET runner_policy = ?2 WHERE slug = ?1`).bind(fixture.slug, JSON.stringify(policy)).run();
    const refused = await switchTo(fixture, 'actions');
    expect(refused.status).toBe(422);
    expect(await problemSlug(refused)).toBe('dispatch-placement-conflict');

    await env.DB.prepare(`UPDATE projects SET runner_policy = '{"mode":"any"}' WHERE slug = ?1`).bind(fixture.slug).run();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
  });

  it('refuses a pinned placement for a project on actions, per project and as the account default it follows', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const accounts = new AccountsRepo(env.DB);
    const audit = {
      accountId: OWNER_ACCOUNT_ID,
      at: new Date().toISOString(),
      actorKind: 'user' as const,
      actor: 'owner',
      kind: 'runner.policy-changed' as const,
      target: fixture.slug,
    };
    const pinned = JSON.stringify({ mode: 'pinned', runner: '01M6YSNJ0000000000000RUNR1' });
    expect(await accounts.setProjectRunnerPolicy(fixture.slug, pinned, audit)).toBe('placement-machine-bound');
    expect(await accounts.setDefaultRunnerPolicy(OWNER_ACCOUNT_ID, pinned, audit)).toBe('placement-machine-bound');
    expect(await accounts.setProjectRunnerPolicy(fixture.slug, JSON.stringify({ mode: 'any' }), audit)).toBe('ok');
    // With its own `any` the project no longer follows the default.
    await switchTo(fixture, 'pull');
  });
});

describe('enqueue of an Actions job', () => {
  it('copies the project’s dispatch, mints actions: write for its one repository and calls workflow_dispatch', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.stub.calls.length = 0;

    const job = await runNow(fixture);
    expect(job.dispatch).toBe('actions');
    expect(job.state).toBe('queued');
    const row = await jobRow(job.id);
    expect(row?.dispatched_at).not.toBeNull();

    const [mint] = actionsMints(fixture.stub);
    expect(mint?.url.pathname).toBe(`/app/installations/${String(INSTALLATION_ID)}/access_tokens`);
    expect(JSON.parse(mint?.body ?? '')).toEqual({ repository_ids: [fixture.repoId], permissions: { actions: 'write' } });
    const [dispatched] = dispatchCalls(fixture.stub);
    expect(dispatched?.url.pathname).toBe(`/repos/${fixture.repo}/actions/workflows/team-console-runner.yml/dispatches`);
    expect(JSON.parse(dispatched?.body ?? '')).toEqual({ ref: 'trunk', inputs: { job_id: job.id } });
    expect(dispatched?.headers.get('authorization')).toMatch(new RegExp(`^Bearer ${TOKEN_SENTINEL}\\d+$`));
    // Never cached: a second job mints its own token.
    await env.DB.prepare(`UPDATE jobs SET state = 'cancelled', finished_at = ?2 WHERE id = ?1`).bind(job.id, new Date().toISOString()).run();
    await runNow(fixture);
    expect(actionsMints(fixture.stub)).toHaveLength(2);
  });

  it('keeps a pull project’s jobs on pull and calls no GitHub', async () => {
    const fixture = await seedProject();
    const job = await runNow(fixture);
    expect(job.dispatch).toBe('pull');
    expect(fixture.stub.calls).toHaveLength(0);
  });

  it('dispatches on the renamed default branch and records it (#695 item 4)', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.defaultBranch = 'main';
    const job = await runNow(fixture);
    const [dispatched] = dispatchCalls(fixture.stub);
    expect(JSON.parse(dispatched?.body ?? '')).toEqual({ ref: 'main', inputs: { job_id: job.id } });
    const row = await env.DB.prepare(`SELECT default_branch FROM projects WHERE slug = ?1`).bind(fixture.slug).first<{ default_branch: string }>();
    expect(row?.default_branch).toBe('main');
  });

  it('fails the job as dispatch-failed: permission missing when the installation lacks actions: write', async () => {
    const fixture = await seedProject({ installationId: SCRIPTED_INSTALLATION });
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const job = await runNow(fixture);
    expect(job.state).toBe('failed');
    expect(job.result).toEqual({ summary: 'dispatch-failed: permission missing', metrics: { reason: 'dispatch-failed' }, acted: false });
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);
  });

  it('fails the job as permission missing when GitHub refuses the dispatch call itself with 403', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.dispatch = () => json(403, { message: 'Resource not accessible by integration' });
    const job = await runNow(fixture);
    expect(job.state).toBe('failed');
    expect(job.result?.['summary']).toBe('dispatch-failed: permission missing');
  });

  it('fails the job as workflow missing when the repository has no runner workflow', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.dispatch = () => json(404, { message: 'Not Found' });
    const job = await runNow(fixture);
    expect(job.result?.['summary']).toBe('dispatch-failed: workflow missing');
  });

  it('refuses a token GitHub minted for another repository, revokes it and never dispatches with it', async () => {
    const fixture = await seedProject({ installationId: SCRIPTED_INSTALLATION });
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.scriptedMint = () =>
      json(201, {
        token: `${TOKEN_SENTINEL}wide`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { actions: 'write' },
        repository_selection: 'selected',
        repositories: [{ id: fixture.repoId + 1, name: 'other', full_name: 'acme/other' }],
      });
    const job = await runNow(fixture);
    expect(job.result?.['summary']).toBe('dispatch-failed: github error');
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);
    expect(fixture.stub.calls.some((entry) => entry.method === 'DELETE' && entry.url.pathname === '/installation/token')).toBe(true);
  });

  it('refuses a token GitHub minted with more than actions: write', async () => {
    const fixture = await seedProject({ installationId: SCRIPTED_INSTALLATION });
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.scriptedMint = (mint) =>
      json(201, {
        token: `${TOKEN_SENTINEL}broad`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { actions: 'write', contents: 'write' },
        repository_selection: 'selected',
        repositories: [{ id: (JSON.parse(mint.body ?? '{}') as { repository_ids: number[] }).repository_ids[0], name: 'x', full_name: 'acme/x' }],
      });
    const job = await runNow(fixture);
    expect(job.result?.['summary']).toBe('dispatch-failed: github error');
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);
  });

  it('answers 422 access-source-hosted, not a 500, for an Actions job of a subscription project (#706)', async () => {
    const fixture = await seedProject({ source: 'subscription' });
    // Only a write that bypasses the switch could leave this state; the enqueue trigger is the last line.
    await env.DB.prepare(`UPDATE projects SET dispatch = 'actions' WHERE slug = ?1`).bind(fixture.slug).run();
    const response = await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/jobs`, { kind: 'slot-dev' });
    expect(response.status).toBe(422);
    expect(await problemSlug(response)).toBe('access-source-hosted');
    const jobs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1`).bind(fixture.slug).first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });

  it('keeps a needs_local job on pull on an Actions project (#695 item 2)', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const response = await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/jobs`, { kind: 'slot-dev', needsLocal: true });
    expect(response.status).toBe(201);
    const job = (await response.json()) as JobDto;
    expect(job.dispatch).toBe('pull');
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);
  });
});

describe('two accounts', () => {
  it('never dispatches through an installation linked to another account, and asks GitHub for no token', async () => {
    const fixture = await seedProject({ installationId: FOREIGN_INSTALLATION });
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.stub.calls.length = 0;
    const job = await runNow(fixture);
    expect(job.state).toBe('failed');
    expect(job.result?.['summary']).toBe('dispatch-failed: installation missing');
    expect(actionsMints(fixture.stub)).toHaveLength(0);
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);
    expect(fixture.stub.calls).toHaveLength(0);
  });
});

describe('the dispatch token never reaches a log (sentinel)', () => {
  it('logs ids and enums only, on a dispatch and on a refused one', async () => {
    const logs: string[] = [];
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions', logs)).status).toBe(200);
    await runNow(fixture, logs);
    // GitHub's own text is never copied either, even when it echoes something token-shaped.
    fixture.world.dispatch = () => json(403, { message: `Bad credentials ${TOKEN_SENTINEL}` });
    await env.DB.prepare(`UPDATE jobs SET state = 'cancelled', finished_at = ?2 WHERE project_slug = ?1 AND state = 'queued'`)
      .bind(fixture.slug, new Date().toISOString())
      .run();
    await runNow(fixture, logs);

    expect(dispatchCalls(fixture.stub).length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('actions job dispatched'))).toBe(true);
    expect(logs.some((line) => line.includes('actions dispatch failed'))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN_SENTINEL);
    }
    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1 AND (result LIKE ?2 OR payload LIKE ?2)`,
    )
      .bind(fixture.slug, `%${TOKEN_SENTINEL}%`)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.project_slug = ?1 AND e.payload LIKE ?2`,
    )
      .bind(fixture.slug, `%${TOKEN_SENTINEL}%`)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);
  });
});

describe('the Cron sweep: actions-no-show', () => {
  it('fails an Actions job no run exchanged within 15 minutes, and leaves a younger one queued', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const job = await runNow(fixture);
    const logger = createLogger({ service: 'spec' }, () => undefined);

    await sweepQueue(env, new Date(Date.now() + 14 * 60_000), logger);
    expect((await jobRow(job.id))?.state).toBe('queued');

    await sweepQueue(env, new Date(Date.now() + 16 * 60_000), logger);
    const row = await jobRow(job.id);
    expect(row?.state).toBe('failed');
    expect(JSON.parse(row?.result ?? '{}')).toEqual({
      summary: 'actions-no-show',
      metrics: { reason: 'actions-no-show' },
      acted: false,
    });
  });
});
