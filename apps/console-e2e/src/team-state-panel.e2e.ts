import type { APIRequestContext } from '@playwright/test';
import { TEAM_CONFIG_SCHEMA, type ClaimResponse, type TeamStatusDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { asRunner, claimStatus, enrolRunner, type E2eRunner } from './support/runner';
import { apiClient, seed, seedFakeRunLog } from './support/stack';
import { switchToConsoleTracker } from './support/tracker-seed';

/**
 * The Commands panel of a console-tracker project reads `team_state` (#738): after a real runner's finish crosses the
 * monthly budget, the panel says the budget stopped the team, the banner says what starts it again, the primary
 * command is Resume, and Run now is refused (#731). The panel's plain Resume lifts the pause, warning first that the
 * month stays at its budget (#733): the state reads running, and the claim still refuses until the month is waived
 * or the budget raised.
 */

const SLUG = 'team-console';

async function setBudget(api: APIRequestContext, monthlyUsd: number): Promise<void> {
  const current = await api.get(`/api/v1/projects/${SLUG}/team-config`);
  const { revision } = (await current.json()) as { revision: number };
  const saved = await api.put(`/api/v1/projects/${SLUG}/team-config`, {
    data: { config: { schema: TEAM_CONFIG_SCHEMA, budget: { monthly_usd: monthlyUsd } } },
    headers: { 'If-Match': `"${String(revision)}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

async function runJob(api: APIRequestContext, runner: E2eRunner, costUsd: number): Promise<void> {
  const queued = await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
  expect(queued.status(), await queued.text()).toBe(201);
  const claim = (await asRunner(api, runner, '/jobs/claim', {})) as ClaimResponse;
  await asRunner(api, runner, `/jobs/${claim.job.id}/finish`, {
    result: 'finished',
    summary: 'Reviewed',
    metrics: { total_cost_usd: costUsd },
  });
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  // The status card still reads the run log for the slots; the pause comes from team_state.
  await seedFakeRunLog(stack);
});

test('after a budget stop the panel shows the budget pause, the banner and Resume; Run now is refused', async ({
  page,
  stack,
}, testInfo) => {
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    const runner = await enrolRunner(api, SLUG);
    await setBudget(api, 1);
    await runJob(api, runner, 1.5);

    const status = (await (await api.get(`/api/v1/projects/${SLUG}/team/status`)).json()) as TeamStatusDto;
    expect(status.state).toBe('paused-by-budget');
    expect(status.budget).toMatchObject({ spentUsd: 1.5, budgetUsd: 1, waivedAt: null });
    // #731: refused as paused, ahead of every other check (locally no slot is set up for Run now).
    const run = await api.post(`/api/v1/projects/${SLUG}/runs`, { data: { slot: 'dev' } });
    expect(run.status()).toBe(409);
    expect(((await run.json()) as { type: string }).type).toMatch(/run-paused$/);

    await page.goto(`/p/${SLUG}/questions`);
    const banner = page.getByTestId('paused-banner');
    await expect(banner).toContainText(ru('commands.banner.budgetRest'));
    await expect(banner.getByTestId('banner-resume')).toHaveAccessibleName(ru('commands.banner.resume'));

    await page.getByTestId('commands-open').click();
    await expect(page.getByTestId('team-state')).toHaveText(ru('commands.status.budget'));
    const resume = page.getByTestId('team-command');
    await expect(resume).toHaveAccessibleName(ru('commands.resume.title'));
    await expect(resume).not.toHaveAttribute('aria-disabled', 'true');
    await expectAccessible(page, 'Commands, team stopped by the budget');

    await resume.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(ru('commands.dialog.resumeBudget'));
    await expectAccessible(page, 'Resume after a budget stop, confirm');
    await confirm.locator('.tc-confirm__ok').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('team-state')).toHaveText(ru('commands.status.running'));
    await expect(page.getByTestId('paused-banner')).toHaveCount(0);

    // A plain resume waives nothing: the month is still at its budget, so the claim hands out no job.
    await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
    expect(await claimStatus(api, runner)).toBe(204);
  } finally {
    await api.dispose();
  }
});
