import { env } from 'cloudflare:test';
import {
  ACTIONS_NOT_READY,
  OWNER_ACCOUNT_ID,
  TEAM_CONFIG_SCHEMA,
  isProblemDetails,
  isProjectDispatchDto,
  problemSlugOf,
  type ClaimResponse,
  type JobDto,
  type OidcExchangeResponse,
} from '@shared/contracts';
import { createLogger, newUlid } from '@worker/core';
import { AccountsRepo, JobsRepo, TeamConfigRepo } from '@worker/db';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  actionsToken,
  createTestIssuer,
  exchangeBodyOf,
  nextRunId,
  postExchange,
  runClaimsOf,
  saveAccessSource,
  type ActionsProject,
  type TestIssuer,
} from '../testing/actions-oidc-kit';
import { cancelJobsInFlight, enrolRunner, runnerJwt, sendAsRunner, type TestRunner } from '../testing/runner-kit';
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
import { SETUP_ORIGIN, answerSetupRead, readyWorld, renderingFor, type SetupWorld } from '../testing/actions-setup-kit';
import type { RunnerWorkflowRendering } from '@shared/actions-workflow';
import { sweepQueue } from './sweep';

// #670 (#573 sub-issue 3): the owner's switch to GitHub Actions and the console's `workflow_dispatch` per job, with
// #695 item 4 (the default branch comes from GitHub), #706 (no Actions path for a subscription project) and #759 PR 3
// (the switch runs the readiness check and refuses `actions-not-ready`). The scripted GitHub starts ready.

/** An installation whose mint the scripted GitHub answers itself (stubGitHub mints for INSTALLATION_ID only). */
const SCRIPTED_INSTALLATION = 778;
/** An installation linked to another account (the two-account case). */
const FOREIGN_INSTALLATION = 779;
const ACCOUNT_B = '01M6YSNJ00000000000000DSB2';

const CLAIM = '/api/v1/runner/jobs/claim';

const DISPATCHES = /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/team-console-runner\.yml\/dispatches$/;

interface World {
  /** The repository read's `default_branch`; changed to model a rename. */
  defaultBranch: string;
  /** The `id` GitHub answers for the registered name. */
  repoId: number | null;
  /** What `POST …/access_tokens` of SCRIPTED_INSTALLATION answers. */
  scriptedMint: (call: GitHubCall) => Response;
  /** What the dispatch POST answers; by default 200 naming a fresh run, as GitHub does with `return_run_details`. */
  dispatch: () => Response;
  /** The runs the default dispatch answer named, in order. */
  readonly runs: string[];
  /** What `DELETE /installation/token` answers (#723 item 1). */
  revoke: () => Response;
  /** #759: what the readiness check reads at the switch; ready unless a case breaks it. */
  readonly setup: SetupWorld;
}

/** GitHub's answer to a dispatch that asked for the run: a run id no other dispatch got, kept in `runs`. */
function runStarted(runs: string[]): Response {
  const runId = nextRunId();
  runs.push(runId);
  return json(200, { workflow_run_id: Number(runId), run_url: 'https://api.github.com/x', html_url: 'https://github.com/x' });
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

let rendering: RunnerWorkflowRendering;

beforeAll(async () => {
  rendering = await renderingFor();
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
    runs: [],
    dispatch: () => runStarted(world.runs),
    revoke: () => new Response(null, { status: 204 }),
    setup: { ...readyWorld(row.repo_id, rendering), defaultBranch: 'trunk', branchPolicies: [{ id: 1, name: 'trunk', type: 'branch' }] },
  };
  world.setup.installationId = options.installationId ?? INSTALLATION_ID;
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
      return world.revoke();
    }
    return answerSetupRead(world.setup, row.repo, rendering, call) ?? json(404, { message: 'Not Found' });
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
  // Served on the configured origin, so the switch's readiness check renders the workflow (#759).
  return fetchApi(path, localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN }), {
    method,
    origin: SETUP_ORIGIN,
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
  return env.DB.prepare(`SELECT state, dispatch, dispatched_at, actions_run_id, result FROM jobs WHERE id = ?1`)
    .bind(id)
    .first<{ state: string; dispatch: string; dispatched_at: string | null; actions_run_id: string | null; result: string | null }>();
}

/** The `workflow_run_id` GitHub answered the fixture's dispatch at `index` with. */
function answeredRunId(fixture: Fixture, index = 0): string {
  const runId = fixture.world.runs[index];
  if (runId === undefined) {
    throw new Error('no run named by a dispatch answer');
  }
  return runId;
}

const revokes = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter((entry) => entry.method === 'DELETE' && entry.url.pathname === '/installation/token');

const dispatchCalls = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter((entry) => entry.method === 'POST' && DISPATCHES.test(entry.url.pathname));
/** The dispatch's mints; the switch's readiness check mints `environment-read` (#759), which is not one. */
const actionsMints = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter(
    (entry) =>
      entry.url.pathname.endsWith('/access_tokens') &&
      (entry.body ?? '').includes('repository_ids') &&
      (entry.body ?? '').includes('"actions":"write"'),
  );

/**
 * The project as a switch made while it was ready left it (#759): the readiness check would refuse the switch in
 * these cases (the permission or the installation link went away later), and drift after the switch is what the
 * dispatch must still judge on its own.
 */
async function alreadyOnActions(fixture: Fixture): Promise<void> {
  await env.DB.prepare(`UPDATE projects SET dispatch = 'actions', default_branch = ?2 WHERE slug = ?1`)
    .bind(fixture.slug, fixture.world.defaultBranch)
    .run();
}

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
  ])('switches to actions under a %s placement and keeps it, for the local-only jobs (#728)', async (_mode, policy) => {
    const fixture = await seedProject();
    await env.DB.prepare(`UPDATE projects SET runner_policy = ?2 WHERE slug = ?1`).bind(fixture.slug, JSON.stringify(policy)).run();
    const switched = await switchTo(fixture, 'actions');
    expect(switched.status).toBe(200);
    const row = await env.DB.prepare(`SELECT dispatch, runner_policy FROM projects WHERE slug = ?1`)
      .bind(fixture.slug)
      .first<{ dispatch: string; runner_policy: string }>();
    expect(row?.dispatch).toBe('actions');
    expect(JSON.parse(row?.runner_policy ?? 'null')).toEqual(policy);
  });

  it('takes a pinned placement on a project already on actions, per project and as the account default (#728)', async () => {
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
    expect(await accounts.setProjectRunnerPolicy(fixture.slug, pinned, audit)).toBe('ok');
    expect(await accounts.setDefaultRunnerPolicy(OWNER_ACCOUNT_ID, pinned, audit)).toBe('ok');
    expect(await accounts.setDefaultRunnerPolicy(OWNER_ACCOUNT_ID, null, audit)).toBe('ok');
    await switchTo(fixture, 'pull');
  });

  it('still refuses actions for a subscription project under a pinned placement (C12 row 6, #728)', async () => {
    const fixture = await seedProject({ source: 'subscription' });
    const mac = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [fixture.slug] });
    const pin = await call(fixture, 'PUT', `/api/v1/projects/${fixture.slug}/runner-policy`, { mode: 'pinned', runner: mac.id });
    expect(pin.status).toBe(200);
    const refused = await switchTo(fixture, 'actions');
    expect(refused.status).toBe(422);
    expect(await problemSlug(refused)).toBe('access-source-hosted');
    const row = await env.DB.prepare(`SELECT dispatch FROM projects WHERE slug = ?1`).bind(fixture.slug).first<{ dispatch: string }>();
    expect(row?.dispatch).toBe('pull');
  });
});

describe('PUT …/dispatch {actions} runs the readiness check (#759 PR 3)', () => {
  const dispatchRow = (slug: string) =>
    env.DB.prepare(`SELECT dispatch, default_branch FROM projects WHERE slug = ?1`)
      .bind(slug)
      .first<{ dispatch: string; default_branch: string | null }>();
  const switchAudits = async (slug: string): Promise<number> =>
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'project.dispatch-changed' AND target = ?1`)
        .bind(slug)
        .first<{ n: number }>()
    )?.n ?? -1;

  it('refuses 422 actions-not-ready with the blocking items in the page’s order; nothing written, nothing audited', async () => {
    const fixture = await seedProject();
    fixture.world.setup.environment = null;
    fixture.world.setup.workflow = null;
    const logs: string[] = [];
    const response = await switchTo(fixture, 'actions', logs);
    expect(response.status).toBe(422);
    const body: unknown = await response.json();
    expect(isProblemDetails(body) && problemSlugOf(body.type)).toBe(ACTIONS_NOT_READY);
    expect((body as { field: string; items: string[] }).items).toEqual(['environment', 'branch-policy', 'secret', 'workflow']);
    expect((body as { field: string }).field).toBe('dispatch');
    expect(await dispatchRow(fixture.slug)).toEqual({ dispatch: 'pull', default_branch: null });
    expect(await switchAudits(fixture.slug)).toBe(0);
    expect(logs.join('\n')).toContain('"items":"environment,branch-policy,secret,workflow"');
  });

  it('holds the switch for permissions not accepted (unknown items), never treating them as ok', async () => {
    const fixture = await seedProject();
    fixture.world.setup.permissions = { metadata: 'read', contents: 'read', actions: 'write' };
    const response = await switchTo(fixture, 'actions');
    expect(response.status).toBe(422);
    expect(((await response.json()) as { items: string[] }).items).toEqual([
      'app-permissions',
      'environment',
      'branch-policy',
      'secret',
    ]);
  });

  it('lets an advisory item through: required reviewers do not hold the switch', async () => {
    const fixture = await seedProject();
    fixture.world.setup.environment = {
      ...fixture.world.setup.environment,
      protection_rules: [{ id: 9, type: 'required_reviewers', reviewers: [] }],
    };
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
  });

  it('refuses through an installation linked to another account with no token minted', async () => {
    const fixture = await seedProject({ installationId: FOREIGN_INSTALLATION });
    const response = await switchTo(fixture, 'actions');
    expect(response.status).toBe(422);
    expect(((await response.json()) as { items: string[] }).items).toContain('app-permissions');
    expect(fixture.stub.calls.filter((entry) => entry.url.pathname.endsWith('/access_tokens'))).toEqual([]);
  });

  it('refuses a subscription project before any GitHub call (#706 keeps its own refusal)', async () => {
    const fixture = await seedProject({ source: 'subscription' });
    const response = await switchTo(fixture, 'actions');
    expect(await problemSlug(response)).toBe('access-source-hosted');
    expect(fixture.stub.calls).toEqual([]);
  });

  it('answers 503 console-origin-misconfigured on a console served elsewhere, and writes nothing', async () => {
    const fixture = await seedProject();
    const response = await fetchApi(`/api/v1/projects/${fixture.slug}/dispatch`, localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN }), {
      method: 'PUT',
      origin: 'http://localhost:4200',
      github: fixture.github,
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dispatch: 'actions' }),
    });
    expect(response.status).toBe(503);
    expect(await problemSlug(response)).toBe('console-origin-misconfigured');
    expect(await dispatchRow(fixture.slug)).toEqual({ dispatch: 'pull', default_branch: null });
    expect(fixture.stub.calls).toEqual([]);
  });

  it('never gates the switch back to pull, and calls no GitHub for it', async () => {
    const fixture = await seedProject();
    await alreadyOnActions(fixture);
    fixture.world.setup.environment = null;
    const response = await switchTo(fixture, 'pull');
    expect(response.status).toBe(200);
    expect(fixture.stub.calls).toEqual([]);
  });
});

describe('placement on an Actions project applies to its pull jobs (#728)', () => {
  beforeEach(cancelJobsInFlight);

  it('a pinned needs_local job waits for the pinned runner; an ordinary job runs on GitHub Actions', async () => {
    const fixture = await seedProject();
    const mac = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [fixture.slug] });
    const linux = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [fixture.slug] });
    const pin = await call(fixture, 'PUT', `/api/v1/projects/${fixture.slug}/runner-policy`, { mode: 'pinned', runner: mac.id });
    expect(pin.status).toBe(200);
    expect((await switchTo(fixture, 'actions')).status).toBe(200);

    const local = await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/jobs`, { kind: 'slot-dev', needsLocal: true });
    expect(local.status).toBe(201);
    const localJob = (await local.json()) as JobDto;
    expect(localJob.dispatch).toBe('pull');
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);

    // The other runner of the account is allowed on the project, but the pin is not its.
    expect((await sendAsRunner(linux, 'POST', CLAIM, {})).status).toBe(204);
    const claimed = await sendAsRunner(mac, 'POST', CLAIM, {});
    expect(claimed.status).toBe(200);
    expect(((await claimed.json()) as ClaimResponse).job.id).toBe(localJob.id);

    const queued = await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/jobs`, { kind: 'review', role: 'qa' });
    expect(queued.status).toBe(201);
    const ordinary = (await queued.json()) as JobDto;
    expect(ordinary.dispatch).toBe('actions');
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
    expect((await jobRow(ordinary.id))?.dispatched_at).not.toBeNull();
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
    expect(JSON.parse(dispatched?.body ?? '')).toEqual({ ref: 'trunk', inputs: { job_id: job.id }, return_run_details: true });
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
    expect(JSON.parse(dispatched?.body ?? '')).toEqual({ ref: 'main', inputs: { job_id: job.id }, return_run_details: true });
    const row = await env.DB.prepare(`SELECT default_branch FROM projects WHERE slug = ?1`).bind(fixture.slug).first<{ default_branch: string }>();
    expect(row?.default_branch).toBe('main');
  });

  it('fails the job as dispatch-failed: permission missing when the installation lacks actions: write', async () => {
    const fixture = await seedProject({ installationId: SCRIPTED_INSTALLATION });
    await alreadyOnActions(fixture);
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
    await alreadyOnActions(fixture);
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
    await alreadyOnActions(fixture);
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
    await alreadyOnActions(fixture);
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

    await sweepQueue(localEnv(), new Date(Date.now() + 14 * 60_000), logger, fixture.github);
    expect((await jobRow(job.id))?.state).toBe('queued');

    await sweepQueue(localEnv(), new Date(Date.now() + 16 * 60_000), logger, fixture.github);
    const row = await jobRow(job.id);
    expect(row?.state).toBe('failed');
    expect(JSON.parse(row?.result ?? '{}')).toEqual({
      summary: 'actions-no-show',
      metrics: { reason: 'actions-no-show' },
      acted: false,
    });
  });
});

// #722 / #716: the dispatch applies the exchange's admission, so a job it would refuse starts no run and waits.
describe('the dispatch admission (#722, #716)', () => {
  let issuer: TestIssuer;
  const logger = createLogger({ service: 'spec' }, () => undefined);

  beforeAll(async () => {
    issuer = await createTestIssuer();
  });

  const actionsProjectOf = (fixture: Fixture): ActionsProject => ({
    slug: fixture.slug,
    accountId: OWNER_ACCOUNT_ID,
    repoId: fixture.repoId,
    repo: fixture.repo,
    defaultBranch: fixture.world.defaultBranch,
  });

  /** Saves revision `expected + 1` of the project's team configuration as `members` (on an API key). */
  async function saveConfig(fixture: Fixture, expected: number, members: Record<string, unknown>): Promise<void> {
    const at = new Date().toISOString();
    const saved = await new TeamConfigRepo(env.DB).save({
      projectSlug: fixture.slug,
      expectedRevision: expected,
      config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' }, ...members },
      diff: [{ path: 'roles' }],
      reason: null,
      id: newUlid(),
      at,
      by: 'owner',
      audit: {
        accountId: OWNER_ACCOUNT_ID,
        at,
        actorKind: 'user',
        actor: 'owner',
        kind: 'team-config.changed',
        target: fixture.slug,
        details: { revision_from: expected, revision_to: expected + 1, paths: ['roles'] },
      },
    });
    expect(saved.kind).toBe('saved');
  }

  /** An Actions project whose team configuration is `members` (revision 2, after seedProject's access source). */
  async function actionsProject(members: Record<string, unknown>): Promise<Fixture> {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    await saveConfig(fixture, 1, members);
    return fixture;
  }

  async function review(fixture: Fixture, role: string): Promise<JobDto> {
    const response = await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/jobs`, { kind: 'review', role });
    expect(response.status).toBe(201);
    return (await response.json()) as JobDto;
  }

  it('max_parallel 1, two Actions jobs of one role: one run, the second dispatched when the first finishes', async () => {
    const fixture = await actionsProject({ roles: { qa: { max_parallel: 1 } } });
    const first = await review(fixture, 'qa');
    const second = await review(fixture, 'qa');
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
    expect(await jobRow(second.id)).toMatchObject({ state: 'queued', dispatched_at: null });

    // The first job's run: its OIDC exchange, then its finish under the ephemeral identity.
    const firstRun = (await jobRow(first.id))?.actions_run_id ?? undefined;
    const exchange = await exchangeBodyOf(await actionsToken(issuer, runClaimsOf(actionsProjectOf(fixture), firstRun)), first.id);
    const exchanged = await postExchange(exchange.body, issuer.bindings);
    expect(exchanged.status).toBe(200);
    const { runner } = (await exchanged.json()) as OidcExchangeResponse;
    const jwt = await runnerJwt({ id: runner.id, privateKey: exchange.privateKey }, { audience: runner.audience });
    const finished = await fetchApi(`/api/v1/runner/jobs/${first.id}/finish`, issuer.bindings, {
      method: 'POST',
      github: fixture.github,
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'finished', summary: 'done', metrics: { total_cost_usd: 0.5 } }),
    });
    expect(finished.status).toBe(200);
    expect(dispatchCalls(fixture.stub)).toHaveLength(2);
    expect((await jobRow(second.id))?.dispatched_at).not.toBeNull();
  });

  it('the Cron sweep dispatches a held-back job once its slot frees, and never fails it as a no-show meanwhile', async () => {
    const fixture = await actionsProject({ roles: { qa: { max_parallel: 1 } } });
    const first = await review(fixture, 'qa');
    const second = await review(fixture, 'qa');
    await sweepQueue(localEnv(), new Date(Date.now() + 10 * 60_000), logger, fixture.github);
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
    expect((await jobRow(second.id))?.state).toBe('queued');

    // The first run never came: it is a no-show, which frees the slot in the same sweep.
    await sweepQueue(localEnv(), new Date(Date.now() + 16 * 60_000), logger, fixture.github);
    expect((await jobRow(first.id))?.state).toBe('failed');
    expect(await jobRow(second.id)).toMatchObject({ state: 'queued' });
    expect((await jobRow(second.id))?.dispatched_at).not.toBeNull();
    expect(dispatchCalls(fixture.stub)).toHaveLength(2);
  });

  it('starts no run for a paused team or a switched-off role; the job waits, and runs once admitted', async () => {
    const fixture = await actionsProject({});
    expect((await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/team/pause`, {})).status).toBe(201);
    const held = await review(fixture, 'analyst');
    expect(held.state).toBe('queued');
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);
    expect(actionsMints(fixture.stub)).toHaveLength(0);

    // Switched off while it waits: the resume alone does not start it.
    await saveConfig(fixture, 2, { roles: { analyst: { enabled: false } } });
    expect((await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/team/resume`, {})).status).toBe(201);
    await sweepQueue(localEnv(), new Date(Date.now() + 30 * 60_000), logger, fixture.github);
    expect(await jobRow(held.id)).toMatchObject({ state: 'queued', dispatched_at: null });
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);

    await saveConfig(fixture, 3, { roles: { analyst: { enabled: true } } });
    await sweepQueue(localEnv(), new Date(Date.now() + 31 * 60_000), logger, fixture.github);
    expect((await jobRow(held.id))?.dispatched_at).not.toBeNull();
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
  });
});

describe('the account’s entitled concurrency at dispatch (#746)', () => {
  let issuer: TestIssuer;

  const setOwnerEntitlements = (json: string) =>
    env.DB.prepare(`UPDATE accounts SET entitlements = ?2 WHERE id = ?1`).bind(OWNER_ACCOUNT_ID, json).run();

  beforeAll(async () => {
    issuer = await createTestIssuer();
    await setOwnerEntitlements('{"max_concurrency":1}');
  });
  afterAll(async () => {
    await setOwnerEntitlements('{"max_concurrency":32}');
  });
  beforeEach(cancelJobsInFlight);

  /** A pull project of the owner's account with a runner allowed on it alone. */
  async function pullProject(): Promise<{ slug: string; runner: TestRunner }> {
    const { slug } = await seedTrackerProject();
    return { slug, runner: await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [slug] }) };
  }

  /**
   * A review job of `slug` by `role` (review jobs share no dedupe key, so one project queues several; the presets'
   * `max_parallel` is the bound's top, and distinct roles keep it out of these cases altogether).
   */
  async function enqueue(fixture: Fixture, slug: string, role = 'qa'): Promise<JobDto> {
    const response = await call(fixture, 'POST', `/api/v1/projects/${slug}/jobs`, { kind: 'review', role });
    expect(response.status).toBe(201);
    return (await response.json()) as JobDto;
  }

  async function finishAs(
    fixture: Fixture,
    runner: Pick<TestRunner, 'id' | 'privateKey'>,
    jobId: string,
    audience?: string,
  ): Promise<void> {
    const jwt = await runnerJwt(runner, audience === undefined ? {} : { audience });
    const finished = await fetchApi(`/api/v1/runner/jobs/${jobId}/finish`, issuer.bindings, {
      method: 'POST',
      github: fixture.github,
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'finished', summary: 'done', metrics: {} }),
    });
    expect(finished.status).toBe(200);
  }

  it('a dispatched run holds the slot: the pull claim gets 204, a second Actions job waits, and its run starts when the first ends', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const pull = await pullProject();

    const first = await enqueue(fixture, fixture.slug);
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
    await enqueue(fixture, pull.slug);
    const refused = await sendAsRunner(pull.runner, 'POST', CLAIM, {});
    expect(refused.status).toBe(204);
    expect(refused.headers.get('Retry-After')).toBe('60');

    const second = await enqueue(fixture, fixture.slug, 'security');
    expect(await jobRow(second.id)).toMatchObject({ state: 'queued', dispatched_at: null });
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);

    // The first run exchanges (its slot was its own) and finishes: the held job's run starts at that finish.
    const project: ActionsProject = {
      slug: fixture.slug,
      accountId: OWNER_ACCOUNT_ID,
      repoId: fixture.repoId,
      repo: fixture.repo,
      defaultBranch: fixture.world.defaultBranch,
    };
    const firstRun = (await jobRow(first.id))?.actions_run_id ?? undefined;
    const exchange = await exchangeBodyOf(await actionsToken(issuer, runClaimsOf(project, firstRun)), first.id);
    const exchanged = await postExchange(exchange.body, issuer.bindings);
    expect(exchanged.status).toBe(200);
    const { runner } = (await exchanged.json()) as OidcExchangeResponse;
    expect((await sendAsRunner(pull.runner, 'POST', CLAIM, {})).status).toBe(204);
    await finishAs(fixture, { id: runner.id, privateKey: exchange.privateKey }, first.id, runner.audience);
    expect(dispatchCalls(fixture.stub)).toHaveLength(2);
    expect((await jobRow(second.id))?.dispatched_at).not.toBeNull();
    expect((await sendAsRunner(pull.runner, 'POST', CLAIM, {})).status).toBe(204);
  });

  it('a pull job’s finish frees the slot for the account’s held Actions job on another project', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const pull = await pullProject();
    const pulled = await enqueue(fixture, pull.slug);
    const claimed = await sendAsRunner(pull.runner, 'POST', CLAIM, {});
    expect(claimed.status).toBe(200);

    const held = await enqueue(fixture, fixture.slug, 'security');
    expect(await jobRow(held.id)).toMatchObject({ state: 'queued', dispatched_at: null });
    expect(dispatchCalls(fixture.stub)).toHaveLength(0);

    await finishAs(fixture, pull.runner, pulled.id);
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
    expect((await jobRow(held.id))?.dispatched_at).not.toBeNull();
  });

  it('the exchange judges the limit too: a run dispatched before the operator lowered it to 0 takes nothing', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const job = await enqueue(fixture, fixture.slug);
    expect(dispatchCalls(fixture.stub)).toHaveLength(1);
    await setOwnerEntitlements('{"max_concurrency":0}');
    try {
      const project: ActionsProject = {
        slug: fixture.slug,
        accountId: OWNER_ACCOUNT_ID,
        repoId: fixture.repoId,
        repo: fixture.repo,
        defaultBranch: fixture.world.defaultBranch,
      };
      const run = (await jobRow(job.id))?.actions_run_id ?? undefined;
      const exchange = await exchangeBodyOf(await actionsToken(issuer, runClaimsOf(project, run)), job.id);
      const refused = await postExchange(exchange.body, issuer.bindings);
      expect(refused.status).toBe(409);
      expect(await jobRow(job.id)).toMatchObject({ state: 'queued' });
      const ephemeral = await env.DB.prepare(`SELECT COUNT(*) AS n FROM runners WHERE isolation = 'actions-ephemeral' AND allowed_projects = ?1`)
        .bind(JSON.stringify([fixture.slug]))
        .first<{ n: number }>();
      expect(ephemeral?.n).toBe(0);
    } finally {
      await setOwnerEntitlements('{"max_concurrency":1}');
    }
  });

  it('max_concurrency 0 starts nothing: no run, no claim', async () => {
    await setOwnerEntitlements('{"max_concurrency":0}');
    try {
      const fixture = await seedProject();
      expect((await switchTo(fixture, 'actions')).status).toBe(200);
      const pull = await pullProject();
      const held = await runNow(fixture);
      await enqueue(fixture, pull.slug);
      expect(await jobRow(held.id)).toMatchObject({ state: 'queued', dispatched_at: null });
      expect(dispatchCalls(fixture.stub)).toHaveLength(0);
      expect(actionsMints(fixture.stub)).toHaveLength(0);
      expect((await sendAsRunner(pull.runner, 'POST', CLAIM, {})).status).toBe(204);
    } finally {
      await setOwnerEntitlements('{"max_concurrency":1}');
    }
  });
});

// #723 item 1: the dispatch token is revoked once its one call is made, whatever GitHub answered.
describe('the dispatch token is revoked after its call (#723 item 1)', () => {
  it('sends DELETE /installation/token with the dispatch token right after the dispatch POST', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.stub.calls.length = 0;
    const job = await runNow(fixture);
    expect(job.state).toBe('queued');

    const order = fixture.stub.calls.map((entry) => `${entry.method} ${entry.url.pathname}`);
    const post = order.findIndex((line) => line.endsWith('/dispatches'));
    expect(post).toBeGreaterThan(-1);
    expect(order.slice(post + 1)).toEqual(['DELETE /installation/token']);
    const [dispatched] = dispatchCalls(fixture.stub);
    const [revoked] = revokes(fixture.stub);
    expect(revoked?.headers.get('authorization')).toBe(dispatched?.headers.get('authorization'));
  });

  it.each([
    ['refuses the dispatch (403)', () => json(403, { message: 'Resource not accessible by integration' }), 'permission missing'],
    ['answers 204 without naming the run', () => new Response(null, { status: 204 }), 'github error'],
    ['is unavailable (503)', () => json(503, { message: 'unavailable' }), 'github unavailable'],
  ])('revokes the token when GitHub %s, and fails the job as %s', async (_label, answer, failure) => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.dispatch = answer;
    fixture.stub.calls.length = 0;
    const job = await runNow(fixture);
    expect(job.state).toBe('failed');
    expect(job.result?.['summary']).toBe(`dispatch-failed: ${failure}`);
    const [dispatched] = dispatchCalls(fixture.stub);
    const [revoked] = revokes(fixture.stub);
    expect(revoked?.headers.get('authorization')).toBe(dispatched?.headers.get('authorization'));
    expect(fixture.stub.calls.at(-1)?.method).toBe('DELETE');
  });

  it('only logs a failed revoke, never the token, and the job stays dispatched', async () => {
    const logs: string[] = [];
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    // The switch's readiness token was revoked already; only the dispatch's revoke is judged here.
    fixture.stub.calls.length = 0;
    fixture.world.revoke = () => json(500, { message: `oops ${TOKEN_SENTINEL}` });
    // GitHubAppAuth writes through its own logger (stdout), as for a refused mint's revoke (#317).
    const stdout = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    let job: JobDto;
    try {
      job = await runNow(fixture, logs);
    } finally {
      stdout.mockRestore();
    }
    expect(job.state).toBe('queued');
    expect((await jobRow(job.id))?.actions_run_id).toBe(answeredRunId(fixture));
    expect(revokes(fixture.stub)).toHaveLength(1);
    const warned = logs.filter((line) => line.includes('dispatch installation token not revoked'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"githubStatus":500');
    for (const line of logs) {
      expect(line).not.toContain(TOKEN_SENTINEL);
    }
  });
});

// #723 item 2: the run GitHub names in its answer is the only run the exchange takes the job for.
describe('the run is bound to the console’s dispatch (#723 item 2)', () => {
  let issuer: TestIssuer;

  beforeAll(async () => {
    issuer = await createTestIssuer();
  });

  const projectOf = (fixture: Fixture): ActionsProject => ({
    slug: fixture.slug,
    accountId: OWNER_ACCOUNT_ID,
    repoId: fixture.repoId,
    repo: fixture.repo,
    defaultBranch: fixture.world.defaultBranch,
  });

  async function exchangeAs(fixture: Fixture, jobId: string, runId: string): Promise<Response> {
    const request = await exchangeBodyOf(await actionsToken(issuer, runClaimsOf(projectOf(fixture), runId)), jobId);
    return postExchange(request.body, issuer.bindings);
  }

  it('records the run GitHub named; a run started by hand for the job is refused, the dispatched run takes it', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const job = await runNow(fixture);
    const dispatchedRun = answeredRunId(fixture);
    expect((await jobRow(job.id))?.actions_run_id).toBe(dispatchedRun);

    // The same job_id input from the Actions tab: every claim but the run id is the console's run's.
    const byHand = await exchangeAs(fixture, job.id, nextRunId());
    expect(byHand.status).toBe(401);
    expect(await byHand.json()).toMatchObject({ claim: 'run_id' });
    expect((await jobRow(job.id))?.state).toBe('queued');

    expect((await exchangeAs(fixture, job.id, dispatchedRun)).status).toBe(200);
    expect((await jobRow(job.id))?.state).toBe('claimed');
  });

  it('starts no claimable job when GitHub names no run: the job fails and every run is refused', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.dispatch = () => json(200, { run_url: 'https://api.github.com/x' });
    const job = await runNow(fixture);
    expect(job.state).toBe('failed');
    expect(job.result?.['summary']).toBe('dispatch-failed: github error');
    expect((await jobRow(job.id))?.actions_run_id).toBeNull();
    expect(await (await exchangeAs(fixture, job.id, nextRunId())).json()).toMatchObject({ status: 409, claim: 'job_id' });
  });
});

// #725: the enqueue answers with the job as the dispatch left it, without reading it back.
describe('POST /projects/:slug/jobs reads an Actions job once (#725)', () => {
  it('answers the dispatched job as written, with one findInProject', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    const reads = vi.spyOn(JobsRepo.prototype, 'findInProject');
    try {
      const job = await runNow(fixture);
      expect(reads).toHaveBeenCalledTimes(1);
      const stored = await new JobsRepo(env.DB).findById(job.id);
      expect(job).toMatchObject({ id: stored?.id, state: 'queued', dispatch: 'actions', result: null });
    } finally {
      reads.mockRestore();
    }
  });

  it('answers a failed dispatch with the job as failed, with one findInProject', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    fixture.world.dispatch = () => json(404, { message: 'Not Found' });
    const reads = vi.spyOn(JobsRepo.prototype, 'findInProject');
    try {
      const job = await runNow(fixture);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(job.state).toBe('failed');
      expect(job.result).toEqual({ summary: 'dispatch-failed: workflow missing', metrics: { reason: 'dispatch-failed' }, acted: false });
    } finally {
      reads.mockRestore();
    }
  });

  it('answers a held-back job as queued and undispatched, with one findInProject', async () => {
    const fixture = await seedProject();
    expect((await switchTo(fixture, 'actions')).status).toBe(200);
    expect((await call(fixture, 'POST', `/api/v1/projects/${fixture.slug}/team/pause`, {})).status).toBe(201);
    const reads = vi.spyOn(JobsRepo.prototype, 'findInProject');
    try {
      const job = await runNow(fixture);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(job.state).toBe('queued');
      expect((await jobRow(job.id))?.dispatched_at).toBeNull();
    } finally {
      reads.mockRestore();
    }
  });
});
