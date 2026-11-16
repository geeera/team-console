import { env } from 'cloudflare:test';
import {
  BUDGET_PAUSER,
  OWNER_ACCOUNT_ID,
  TEAM_CONFIG_SCHEMA,
  isProblemDetails,
  problemSlugOf,
  type ClaimResponse,
  type JobDto,
  type NeedsYouDto,
  type TeamConfigDto,
} from '@shared/contracts';
import { enrolRunner, sendAsRunner, type TestRunner } from '../testing/runner-kit';
import { seedTrackerProject, send, type SeededProject } from '../testing/tracker-kit';

// #684 (ADR 0009 d.6, threat model C12 row 5 / T6): the budget stop through the whole app, from the runner's finish
// to the owner's Needs-you row and its two actions, and the role limits at enqueue.

const P = '/api/v1/projects';

afterEach(async () => {
  // Needs you lists every active project of the owner's account; archive what a case registered.
  await env.DB.prepare(
    `UPDATE projects SET archived_at = '2026-11-05T00:00:00Z' WHERE archived_at IS NULL`,
  ).run();
});

async function problemSlug(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

async function configure(project: SeededProject, members: Record<string, unknown>): Promise<TeamConfigDto> {
  const current = (await (await send('GET', `${P}/${project.slug}/team-config`)).json()) as TeamConfigDto;
  const response = await send(
    'PUT',
    `${P}/${project.slug}/team-config`,
    { config: { schema: TEAM_CONFIG_SCHEMA, ...members } },
    { ifMatch: `"${String(current.revision)}"` },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as TeamConfigDto;
}

async function runNow(project: SeededProject, body: Record<string, unknown>): Promise<Response> {
  return send('POST', `${P}/${project.slug}/jobs`, body);
}

async function enqueue(project: SeededProject, role = 'qa'): Promise<string> {
  const response = await runNow(project, { kind: 'review', role });
  expect(response.status).toBe(201);
  return ((await response.json()) as JobDto).id;
}

async function claim(runner: TestRunner): Promise<ClaimResponse | null> {
  const response = await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {});
  if (response.status === 204) {
    return null;
  }
  expect(response.status).toBe(200);
  return (await response.json()) as ClaimResponse;
}

const finish = (
  runner: TestRunner,
  jobId: string,
  metrics: Record<string, unknown>,
  logs?: string[],
): Promise<Response> =>
  sendAsRunner(
    runner,
    'POST',
    `/api/v1/runner/jobs/${jobId}/finish`,
    { result: 'finished', summary: 'done', metrics },
    {
      ...(logs === undefined ? {} : { logSink: (line: string) => logs.push(line) }),
    },
  );

async function budgetStopOf(project: SeededProject): Promise<unknown> {
  const response = await send('GET', '/api/v1/needs-you');
  expect(response.status).toBe(200);
  const body = (await response.json()) as NeedsYouDto;
  return body.projects.find((row) => row.slug === project.slug)?.budgetStop;
}

describe('POST …/runner/jobs/:id/finish: metrics.total_cost_usd', () => {
  it('refuses a cost that is not a finite number of dollars in [0, 10000] with 422 job-finish-invalid', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const jobId = await enqueue(project);
    expect((await claim(runner))?.job.id).toBe(jobId);
    for (const bad of [-0.01, 10_000.01, '1.5', null, true, { usd: 1 }]) {
      const response = await finish(runner, jobId, { total_cost_usd: bad });
      expect(response.status).toBe(422);
      expect(await problemSlug(response)).toBe('job-finish-invalid');
      expect(((await response.json()) as { field?: string }).field).toBe('metrics.total_cost_usd');
    }
    // The runners before #684 report it as costUsd: held to the same bound.
    const legacy = await finish(runner, jobId, { costUsd: 1e9 });
    expect(((await legacy.json()) as { field?: string }).field).toBe('metrics.costUsd');
    expect(
      (await env.DB.prepare(`SELECT state FROM jobs WHERE id = ?1`).bind(jobId).first<{ state: string }>())
        ?.state,
    ).toBe('claimed');

    expect((await finish(runner, jobId, { total_cost_usd: 10_000 })).status).toBe(200);
    const spend = await env.DB.prepare(`SELECT spent_usd, jobs FROM project_spend WHERE project_slug = ?1`)
      .bind(project.slug)
      .first<{ spent_usd: number; jobs: number }>();
    expect(spend).toEqual({ spent_usd: 10_000, jobs: 1 });
  });

  it('counts an absent cost as nothing and logs it; a replayed finish adds nothing', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const first = await enqueue(project);
    await claim(runner);
    const logs: string[] = [];
    expect((await finish(runner, first, { exitCode: 0 }, logs)).status).toBe(200);
    expect(logs.some((line) => line.includes('job finished without a cost'))).toBe(true);

    const second = await enqueue(project);
    await claim(runner);
    expect((await finish(runner, second, { total_cost_usd: 2.5 })).status).toBe(200);
    expect((await finish(runner, second, { total_cost_usd: 2.5 })).status).toBe(409);
    const spend = await env.DB.prepare(`SELECT spent_usd, jobs FROM project_spend WHERE project_slug = ?1`)
      .bind(project.slug)
      .first<{ spent_usd: number; jobs: number }>();
    expect(spend).toEqual({ spent_usd: 2.5, jobs: 2 });
  });
});

describe('the budget stop and its Needs-you row', () => {
  async function stoppedProject(): Promise<{ project: SeededProject; runner: TestRunner }> {
    const project = await seedTrackerProject();
    await configure(project, { budget: { monthly_usd: 5 }, roles: { qa: { max_parallel: 3 } } });
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, {
      allowedProjects: [project.slug],
      enrol: { capabilities: { local: true, maxConcurrency: 4 } },
    });
    const held: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      await enqueue(project);
      const claimed = await claim(runner);
      held.push(claimed?.job.id ?? '');
    }
    // Three jobs in flight finish together after the cap is crossed.
    const answers = await Promise.all(held.map(async (id) => finish(runner, id, { total_cost_usd: 2 })));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    return { project, runner };
  }

  it('N parallel finishes past the cap give one pause, one row with the figures, and no further claim', async () => {
    const { project, runner } = await stoppedProject();
    const stop = await budgetStopOf(project);
    expect(stop).toMatchObject({ spentUsd: 6, budgetUsd: 5, month: new Date().toISOString().slice(0, 7) });
    const pauses = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'team.paused' AND target = ?1 AND actor = 'budget'`,
    )
      .bind(project.slug)
      .first<{ n: number }>();
    expect(pauses?.n).toBe(1);
    await enqueue(project);
    expect(await claim(runner)).toBeNull();
    expect(
      (
        await env.DB.prepare(`SELECT paused_by FROM team_state WHERE project_slug = ?1`)
          .bind(project.slug)
          .first<{ paused_by: string }>()
      )?.paused_by,
    ).toBe(BUDGET_PAUSER);
  });

  it('“Resume this month” (resume with waiveBudget) clears the row and the queue runs again this month', async () => {
    const { project, runner } = await stoppedProject();
    const resumed = await send('POST', `${P}/${project.slug}/team/resume`, { waiveBudget: true });
    expect(resumed.status).toBe(201);
    expect(await budgetStopOf(project)).toBeUndefined();
    const waived = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'team.budget-waived' AND target = ?1`,
    )
      .bind(project.slug)
      .first<{ details: string }>();
    expect(JSON.parse(waived?.details ?? '{}')).toMatchObject({ waivedMonth: new Date().toISOString().slice(0, 7) });
    const next = await enqueue(project);
    expect((await claim(runner))?.job.id).toBe(next);
  });

  it('a plain resume (the commands panel, #733) lifts the pause but waives nothing: the row stays, the claim refuses', async () => {
    const { project, runner } = await stoppedProject();
    expect((await send('POST', `${P}/${project.slug}/team/resume`, {})).status).toBe(201);
    expect(await budgetStopOf(project)).toMatchObject({ spentUsd: 6, budgetUsd: 5, stoppedAt: null });
    await enqueue(project);
    expect(await claim(runner)).toBeNull();
    // The row's own resume then waives the month although nothing is paused any more.
    expect((await send('POST', `${P}/${project.slug}/team/resume`, { waiveBudget: true })).status).toBe(201);
    expect(await claim(runner)).not.toBeNull();
    const invalid = await send('POST', `${P}/${project.slug}/team/resume`, { waiveBudget: 'yes' });
    expect(invalid.status).toBe(422);
  });

  it('“Raise budget” (a save above the spend) clears the row; a budget lowered under the spend stops the next claim', async () => {
    const { project, runner } = await stoppedProject();
    await configure(project, { budget: { monthly_usd: 20 }, roles: { qa: { max_parallel: 3 } } });
    expect(await budgetStopOf(project)).toBeUndefined();
    const next = await enqueue(project);
    expect((await claim(runner))?.job.id).toBe(next);

    await configure(project, { budget: { monthly_usd: 6 }, roles: { qa: { max_parallel: 3 } } });
    expect(await budgetStopOf(project)).toMatchObject({ spentUsd: 6, budgetUsd: 6 });
    await enqueue(project);
    expect(await claim(runner)).toBeNull();
  });
});

describe('POST …/jobs: the role’s limits at enqueue', () => {
  it('lowers a larger maxMinutes to the role’s max_minutes, and takes the role’s when none is asked', async () => {
    const project = await seedTrackerProject();
    await configure(project, { roles: { qa: { max_minutes: 30 } } });
    const larger = await runNow(project, { kind: 'review', role: 'qa', maxMinutes: 600 });
    expect(larger.status).toBe(201);
    expect(((await larger.json()) as JobDto).maxMinutes).toBe(30);
    const smaller = await runNow(project, { kind: 'review', role: 'qa', maxMinutes: 10 });
    expect(((await smaller.json()) as JobDto).maxMinutes).toBe(10);
    const none = await runNow(project, { kind: 'review', role: 'qa' });
    expect(((await none.json()) as JobDto).maxMinutes).toBe(30);
  });

  it('refuses a job of a role the team configuration switched off with 409 role-disabled', async () => {
    const project = await seedTrackerProject();
    await configure(project, { roles: { analyst: { enabled: false } } });
    const response = await runNow(project, { kind: 'review', role: 'analyst' });
    expect(response.status).toBe(409);
    expect(await problemSlug(response)).toBe('role-disabled');
    const queued = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1`)
      .bind(project.slug)
      .first<{ n: number }>();
    expect(queued?.n).toBe(0);
  });
});
