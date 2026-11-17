import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  OWNER_ACCOUNT_ID,
  TEAM_CONFIG_SCHEMA,
  runnerAudienceOf,
  type ClaimResponse,
} from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed, type Stack } from './support/stack';
import { switchToConsoleTracker } from './support/tracker-seed';

/**
 * The budget stop (#684) end to end: the owner sets a monthly budget, a real runner (enrolled through the owner's code,
 * its own Ed25519 key) finishes a job whose Claude Code cost crosses it, and Needs you shows the one "Budget used up"
 * row with the figures. `Resume this month` asks "Spending may exceed {budget}." first and resumes the team; `Raise
 * budget` states the overshoot bound and saves a budget above the spend. Either way the row is gone and the next job
 * is claimed. The runner's calls are its own HTTP API, no browser.
 */

const SLUG = 'team-console';

interface Runner {
  readonly id: string;
  readonly key: KeyObject;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

function runnerJwt(runner: Runner): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'EdDSA' }));
  const claims = base64url(
    JSON.stringify({
      sub: runner.id,
      aud: runnerAudienceOf('local'),
      iat: now,
      exp: now + 240,
      jti: randomUUID(),
    }),
  );
  return `${header}.${claims}.${base64url(sign(null, Buffer.from(`${header}.${claims}`), runner.key))}`;
}

async function enrolRunner(api: APIRequestContext): Promise<Runner> {
  const code = await api.post(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
    data: { name: 'E2E Mac', allowedProjects: [SLUG] },
  });
  expect(code.status(), await code.text()).toBe(201);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const enrolled = await api.post('/api/v1/runner/enrol', {
    data: {
      code: ((await code.json()) as { code: string }).code,
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x },
      host: { os: 'darwin', arch: 'arm64', hostname: 'e2e-mac.local' },
      capabilities: { local: true, maxConcurrency: 1 },
      isolation: 'user',
      version: '0.3.0',
    },
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
  return { id: ((await enrolled.json()) as { runnerId: string }).runnerId, key: privateKey };
}

async function asRunner(
  api: APIRequestContext,
  runner: Runner,
  path: string,
  data: unknown,
): Promise<unknown> {
  const response = await api.post(`/api/v1/runner${path}`, {
    data,
    headers: { Authorization: `Bearer ${runnerJwt(runner)}` },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  const text = await response.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
}

/** The owner saves `budget.monthly_usd` over the current revision. */
async function setBudget(api: APIRequestContext, monthlyUsd: number): Promise<void> {
  const current = await api.get(`/api/v1/projects/${SLUG}/team-config`);
  const { revision } = (await current.json()) as { revision: number };
  const saved = await api.put(`/api/v1/projects/${SLUG}/team-config`, {
    data: { config: { schema: TEAM_CONFIG_SCHEMA, budget: { monthly_usd: monthlyUsd } } },
    headers: { 'If-Match': `"${String(revision)}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Queues one review job and has the runner claim it, before the job itself finishes. */
async function claimJob(api: APIRequestContext, runner: Runner): Promise<ClaimResponse> {
  const queued = await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
  expect(queued.status(), await queued.text()).toBe(201);
  return (await asRunner(api, runner, '/jobs/claim', {})) as ClaimResponse;
}

async function finishJob(api: APIRequestContext, runner: Runner, jobId: string, costUsd: number): Promise<void> {
  await asRunner(api, runner, `/jobs/${jobId}/finish`, {
    result: 'finished',
    summary: 'Reviewed',
    metrics: { total_cost_usd: costUsd },
  });
}

/** One review job, claimed by the runner and finished at `costUsd` (Claude Code's own `total_cost_usd`). */
async function runJob(api: APIRequestContext, runner: Runner, costUsd: number): Promise<void> {
  const claim = await claimJob(api, runner);
  await finishJob(api, runner, claim.job.id, costUsd);
}

async function claimStatus(api: APIRequestContext, runner: Runner): Promise<number> {
  const response = await api.post('/api/v1/runner/jobs/claim', {
    data: {},
    headers: { Authorization: `Bearer ${runnerJwt(runner)}` },
  });
  return response.status();
}

const money = (usd: number): string =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(usd) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(usd);
const month = (): string =>
  new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' }).format(new Date());
const spaced = (text: string): string => text.trim().replace(/\s/g, ' ');

/** A stack whose team the budget stopped: $1 budget, one job that cost $1.50. */
async function stopped(
  stack: Stack,
  workerIndex: number,
): Promise<{ api: APIRequestContext; runner: Runner; name: string }> {
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  const runner = await enrolRunner(api);
  await setBudget(api, 1);
  await runJob(api, runner, 1.5);
  const projects = (await (await api.get('/api/v1/projects')).json()) as {
    slug: string;
    displayName: string;
  }[];
  return { api, runner, name: projects.find((project) => project.slug === SLUG)?.displayName ?? SLUG };
}

/**
 * The same stop, but the owner pauses the team between claim and finish (#739's repro): a job claimed before the
 * budget was reached finishes after both the pause and the budget crossing, so `budgetStopsOf` reports
 * `stoppedAt: null` — an owner's pause is kept and never replaced by the budget mechanism.
 */
async function pausedThenStopped(
  stack: Stack,
  workerIndex: number,
): Promise<{ api: APIRequestContext; runner: Runner; name: string }> {
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  const runner = await enrolRunner(api);
  await setBudget(api, 1);
  const claim = await claimJob(api, runner);
  const paused = await api.post(`/api/v1/projects/${SLUG}/team/pause`, { data: { reason: 'owner pause' } });
  expect(paused.status(), await paused.text()).toBe(201);
  await finishJob(api, runner, claim.job.id, 1.5);
  const projects = (await (await api.get('/api/v1/projects')).json()) as {
    slug: string;
    displayName: string;
  }[];
  return { api, runner, name: projects.find((project) => project.slug === SLUG)?.displayName ?? SLUG };
}

async function expectRow(page: Page, name: string): Promise<void> {
  const row = page.getByRole('region', { name: ru('budget.stop.title', { project: name }) });
  await expect(row).toBeVisible();
  await expect(row).toHaveCount(1);
  expect(spaced((await row.getByTestId('budget-stop-body').textContent()) ?? '')).toBe(
    spaced(ru('budget.stop.body', { spent: money(1.5), budget: money(1), month: month() })),
  );
}

test.beforeEach(({ stack }) => {
  requireLocalStack(stack);
});

test('the budget stops the team; Needs you shows one row; Resume this month asks first and resumes', async ({
  page,
  stack,
}, testInfo) => {
  const { api, runner, name } = await stopped(stack, testInfo.workerIndex);
  try {
    // A second finish past the cap would not add a row; the claim refuses the next job.
    await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
    expect(await claimStatus(api, runner)).toBe(204);

    await page.goto('/needs-you');
    await expectRow(page, name);
    await expectAccessible(page, 'Needs you, budget used up');

    await page.getByRole('button', { name: ru('budget.stop.resume') }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(spaced(ru('budget.resume.message', { budget: money(1) })));
    await expectAccessible(page, 'Resume this month, confirm');
    await dialog.getByRole('button', { name: ru('budget.resume.confirm') }).click();

    await expect(page.getByRole('status').filter({ hasText: ru('budget.resumed') })).toBeVisible();
    await expect(page.getByTestId('budget-stop')).toHaveCount(0);
    expect(await claimStatus(api, runner)).toBe(200);
  } finally {
    await api.dispose();
  }
});

test('Raise budget states the overshoot bound and saves a budget above the spend, which lifts the stop', async ({
  page,
  stack,
}, testInfo) => {
  const { api, runner, name } = await stopped(stack, testInfo.workerIndex);
  try {
    await page.goto('/needs-you');
    await expectRow(page, name);

    await page.getByRole('button', { name: ru('budget.stop.raise') }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(ru('budget.overshoot'));
    const field = dialog.getByRole('textbox', { name: ru('budget.raise.label') });
    await expect(field).toHaveValue('1');
    await expectAccessible(page, 'Raise budget, dialog');

    // The current budget is not above the spend: the field says why and Save stays off.
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('button', { name: ru('budget.raise.confirm') })).toBeDisabled();

    await field.fill('25');
    await dialog.getByRole('button', { name: ru('budget.raise.confirm') }).click();
    await expect(page.getByRole('status').filter({ hasText: ru('budget.resumed') })).toBeVisible();
    await expect(page.getByTestId('budget-stop')).toHaveCount(0);

    const config = (await (await api.get(`/api/v1/projects/${SLUG}/team-config`)).json()) as {
      budget: { monthly_usd: number };
    };
    expect(config.budget.monthly_usd).toBe(25);
    await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
    expect(await claimStatus(api, runner)).toBe(200);
  } finally {
    await api.dispose();
  }
});

test('beside an owner’s own pause, Raise says the team stays paused and never claims a restart (#739)', async ({
  page,
  stack,
}, testInfo) => {
  const { api, runner, name } = await pausedThenStopped(stack, testInfo.workerIndex);
  try {
    await page.goto('/needs-you');
    await expectRow(page, name);

    await page.getByRole('button', { name: ru('budget.stop.raise') }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(
      spaced(ru('budget.raise.messagePaused', { spent: money(1.5), month: month() })),
    );
    expect(await dialog.textContent()).not.toContain('снова запустит команду');
    await expectAccessible(page, 'Raise budget, stays paused');

    const field = dialog.getByRole('textbox', { name: ru('budget.raise.label') });
    await field.fill('25');
    await dialog.getByRole('button', { name: ru('budget.raise.confirm') }).click();

    await expect(page.getByRole('status').filter({ hasText: ru('budget.raise.savedStillPaused') })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: ru('budget.resumed') })).toHaveCount(0);
    await expect(page.getByTestId('budget-stop')).toHaveCount(0);

    // The owner's own pause (real, in `team_state`) still holds: the claim keeps refusing past the raised budget.
    await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
    expect(await claimStatus(api, runner)).toBe(204);
  } finally {
    await api.dispose();
  }
});

test('Needs you "Open limits" opens Team at the budget; the Team callout resumes the month; Limits says a changed budget ends the waiver (#688)', async ({
  page,
  stack,
}, testInfo) => {
  const { api, runner, name } = await stopped(stack, testInfo.workerIndex);
  try {
    await page.goto('/needs-you');
    await expectRow(page, name);
    await page.getByRole('link', { name: ru('budget.stop.openLimits') }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}/team\\?focus=budget$`));
    const budget = page.getByTestId('input-budget.monthly_usd');
    await expect(budget).toBeFocused();

    const callout = page.getByRole('region', { name: ru('teamConfig.budget.title') });
    expect(spaced((await callout.getByTestId('team-budget-body').textContent()) ?? '')).toBe(
      spaced(ru('budget.stop.body', { spent: money(1.5), budget: money(1), month: month() })),
    );
    await expectAccessible(page, 'Settings › Team, budget used up');

    // Raise budget is an ordinary edit: it takes the owner to the same field.
    await page.getByTestId('team-title').focus();
    await callout.getByRole('button', { name: ru('budget.stop.raise') }).click();
    await expect(budget).toBeFocused();

    await callout.getByRole('button', { name: ru('budget.stop.resume') }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(spaced(ru('budget.resume.message', { budget: money(1) })));
    await dialog.getByRole('button', { name: ru('budget.resume.confirm') }).click();
    await expect(page.getByRole('status').filter({ hasText: ru('budget.resumed') })).toBeVisible();
    await expect(callout).toHaveCount(0);

    // The waived month: Limits says why the budget does not stop the team, and that a changed budget ends it.
    const waived = page.getByTestId('team-waived');
    const monthName = month();
    await expect(waived.getByRole('heading')).toHaveText(
      ru('teamConfig.budget.waivedTitle', { month: monthName.charAt(0).toUpperCase() + monthName.slice(1) }),
    );
    await expect(waived.getByTestId('team-waived-ends')).toHaveText(ru('teamConfig.budget.waivedEnds'));
    await expectAccessible(page, 'Settings › Team, waived month');
    await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role: 'qa' } });
    expect(await claimStatus(api, runner)).toBe(200);

    await budget.fill('30');
    await page.getByTestId('save-bar-review').click();
    await page.getByRole('dialog').getByTestId('review-save').click();
    await expect(page.getByTestId('team-title')).toBeFocused();
    await expect(waived).toHaveCount(0);
    const status = (await (await api.get(`/api/v1/projects/${SLUG}/team/status`)).json()) as {
      budget: { waivedAt: string | null; budgetUsd: number | null };
    };
    expect(status.budget).toMatchObject({ waivedAt: null, budgetUsd: 30 });
  } finally {
    await api.dispose();
  }
});
