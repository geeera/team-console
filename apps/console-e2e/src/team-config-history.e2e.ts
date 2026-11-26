import type { APIRequestContext, Page, Route } from '@playwright/test';
import { TEAM_CONFIG_SCHEMA, problemTypeOf, type TeamConfigDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { scrollsSideways, tabTo } from './support/keyboard';
import { apiClient, seed, type Stack } from './support/stack';
import { meetsMinTap } from './support/tap-target';
import { switchToConsoleTracker } from './support/tracker-seed';

/**
 * Settings › Team, slice 2 (#688) on the local stack: the revision history (n, author, time, reason; a diff in words,
 * the raw JSON, "Use as draft" — never a restore), the T4 `<img onerror>` reason read back as text, the history's own
 * error (the partial state), and the import from project.yml (a draft with notes that never saves, a failure with
 * Try again), by keyboard and on a 375 px phone. The revisions and the import are the real Worker's; only the
 * failures are stubbed.
 */

const SLUG = 'team-console';
const URL = `/settings/projects/${SLUG}/team`;
const API = `/api/v1/projects/${SLUG}/team-config`;
const SCRIPT_REASON = '<img src=x onerror=alert(1)> QA on Sonnet';

async function prepared(stack: Stack, workerIndex: number): Promise<APIRequestContext> {
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(workerIndex, SLUG, 'TC');
  return apiClient(stack);
}

async function stored(api: APIRequestContext): Promise<TeamConfigDto> {
  const response = await api.get(API);
  expect(response.status()).toBe(200);
  return (await response.json()) as TeamConfigDto;
}

async function save(
  api: APIRequestContext,
  config: object,
  revision: number,
  reason?: string,
): Promise<void> {
  const response = await api.put(API, {
    data: {
      config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' }, ...config },
      ...(reason === undefined ? {} : { reason }),
    },
    headers: { 'If-Match': `"${String(revision)}"` },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function openTeam(page: Page): Promise<void> {
  await page.goto(URL);
  await expect(page.getByRole('heading', { level: 1, name: ru('teamConfig.title') })).toBeVisible();
  await expect(page.getByTestId('role-dev')).toBeVisible();
}

/** Fails the test if any script the page was given runs (T4): an `alert` would open a dialog. */
function forbidScripts(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

test.beforeEach(({ stack }) => {
  requireLocalStack(stack);
});

test('the history lists revisions, opens one as a diff in words and raw JSON, and Use as draft is a draft until saved — by keyboard', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  const dialogs = forbidScripts(page);
  try {
    await save(
      api,
      { roles: { qa: { model: 'claude-sonnet-5', effort: 'medium' } }, budget: { monthly_usd: 200 } },
      0,
      SCRIPT_REASON,
    );
    const firstLanguage = (await stored(api)).resolved.language;
    await save(api, { language: firstLanguage === 'en' ? 'ru' : 'en' }, 1);
    await openTeam(page);
    // The current revision has no reason; revision 1's reason is in the history, as text.
    await expect(page.getByTestId('team-revision')).toContainText(
      ru('teamConfig.history.revision', { n: 2 }),
    );
    await expect(page.getByTestId('team-revision-reason')).toHaveCount(0);

    await tabTo(page, page.getByTestId('team-history'), page.getByTestId('team-import'));
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: ru('teamConfig.history.title') });
    await expect(sheet.getByTestId('history-list')).toBeVisible();
    const rows = sheet.locator('[data-testid^="history-row-"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'history-row-2');
    await expect(sheet.getByTestId('history-row-2').getByTestId('history-reason')).toHaveText(
      ru('teamConfig.history.noReason'),
    );
    await expect(sheet.getByTestId('history-row-1').getByTestId('history-reason')).toHaveText(SCRIPT_REASON);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expectAccessible(page, 'Settings › Team, history');

    await tabTo(
      page,
      sheet.getByTestId('history-row-1').getByRole('button'),
      sheet.getByTestId('history-row-2').getByRole('button'),
    );
    await page.keyboard.press('Enter');
    const revision = sheet.getByTestId('revision');
    await expect(
      revision.getByRole('heading', { name: ru('teamConfig.history.revision', { n: 1 }) }),
    ).toBeFocused();
    await expect(revision.getByTestId('revision-reason')).toHaveText(SCRIPT_REASON);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    const table = revision.getByRole('table');
    await expect(table.locator('[data-path="roles.qa.model"]')).toContainText('Sonnet 5');
    await expect(table.locator('[data-path="budget.monthly_usd"]')).toContainText(
      ru('teamConfig.history.notSet'),
    );
    await expect(revision.getByRole('button', { name: /восстанов|restore/i })).toHaveCount(0);
    await expectAccessible(page, 'Settings › Team, revision diff');

    const toggle = revision.getByTestId('revision-raw-toggle');
    await tabTo(page, toggle);
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const raw = JSON.parse((await revision.getByTestId('revision-raw').textContent()) ?? '') as Record<
      string,
      unknown
    >;
    expect(raw['roles.qa.model']).toEqual({ to: 'claude-sonnet-5' });

    await tabTo(
      page,
      revision.getByTestId('revision-use'),
      revision.getByRole('heading', { name: ru('teamConfig.history.revision', { n: 1 }) }),
    );
    await page.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    const bar = page.getByRole('region', { name: ru('teamConfig.bar.label') });
    await expect(bar).toBeVisible();
    // Taking revision 1 brings its model, budget and language back as a draft; nothing is saved yet.
    expect((await stored(api)).revision).toBe(2);

    await tabTo(page, bar.getByTestId('save-bar-review'), bar.getByTestId('save-bar-discard'));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('dialog').getByTestId('review-save'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('team-title')).toBeFocused();
    const view = await stored(api);
    expect(view.revision).toBe(3);
    expect(view.resolved.roles.qa.model).toBe('claude-sonnet-5');
    expect(view.budget.monthly_usd).toBe(200);
    expect(view.resolved.language).toBe(firstLanguage);
    expect(dialogs).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('a history that fails to load is its own error with Try again; the form behind stays (partial state)', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await save(api, { budget: { monthly_usd: 90 } }, 0, 'First budget');
    let failing = true;
    await page.route(`**${API}/revisions?**`, async (route: Route) => {
      if (failing) {
        await route.fulfill({
          status: 503,
          json: { type: problemTypeOf('unavailable'), title: 'x', status: 503 },
        });
        return;
      }
      await route.fallback();
    });
    await openTeam(page);
    await expect(page.getByTestId('team-revision-reason')).toHaveText('First budget');
    await page.getByTestId('team-history').click();
    const sheet = page.getByRole('dialog', { name: ru('teamConfig.history.title') });
    const error = sheet.getByTestId('history-error');
    await expect(error).toContainText(ru('teamConfig.history.failedTitle'));
    await expect(error).toContainText(ru('teamConfig.history.failed'));
    await expectAccessible(page, 'Settings › Team, history did not load');
    failing = false;
    await error.getByTestId('history-retry').click();
    await expect(sheet.getByTestId('history-row-1')).toContainText('First budget');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('team-history')).toBeFocused();
    await expect(page.getByTestId('role-dev')).toBeVisible();
  } finally {
    await api.dispose();
  }
});

test('import from project.yml: a failure offers Try again, the draft shows what changes, and Use as draft never saves — by keyboard', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    // The repository's project.yml says QA always and one rework round; the console holds code-only and three.
    await save(api, { gates: { qa: 'code', max_rework_rounds: 3 }, budget: { monthly_usd: 120 } }, 0);
    let failing = true;
    await page.route(`**${API}/import`, async (route: Route) => {
      if (failing) {
        failing = false;
        await route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          json: {
            type: problemTypeOf('team-config-import-invalid'),
            title: 'x',
            status: 422,
            field: 'project.yml',
          },
        });
        return;
      }
      await route.fallback();
    });
    await openTeam(page);
    await tabTo(page, page.getByTestId('team-import'), page.getByTestId('team-title'));
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: ru('teamConfig.import.title') });
    const error = sheet.getByTestId('import-error');
    await expect(error).toContainText(ru('teamConfig.import.failedTitle'));
    await expect(error).toContainText(ru('teamConfig.import.failed.unreadable'));
    await expectAccessible(page, 'Settings › Team, import failed');
    await tabTo(page, sheet.getByTestId('import-retry'));
    await page.keyboard.press('Enter');

    const table = sheet.getByRole('table');
    await expect(table.locator('[data-path="gates.qa"]')).toContainText(ru('teamConfig.rules.gate.always'));
    await expect(table.locator('[data-path="gates.max_rework_rounds"]')).toContainText('1');
    await expect(table.locator('[data-path="budget.monthly_usd"]')).toHaveCount(0);
    await expect(sheet.getByTestId('import-source')).toContainText('project.yml');
    await expect(sheet).toContainText(ru('teamConfig.import.savesNothing'));
    await expectAccessible(page, 'Settings › Team, import draft');

    await tabTo(page, sheet.getByTestId('import-use'));
    await page.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    const bar = page.getByRole('region', { name: ru('teamConfig.bar.label') });
    await expect(bar.getByTestId('save-bar-count')).toHaveText(ru('teamConfig.bar.count.few', { n: 2 }));
    // A draft only: the stored revision, its rules and its budget are untouched.
    const view = await stored(api);
    expect(view.revision).toBe(1);
    expect(view.resolved.gates.qa).toBe('code');
    expect(view.budget.monthly_usd).toBe(120);
  } finally {
    await api.dispose();
  }
});

test('on a 375 px phone the history, a revision and the import never scroll sideways and every target is 44 px', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await save(
      api,
      { roles: { qa: { model: 'claude-sonnet-5' } }, gates: { code_paths: ['apps/**', 'libs/**'] } },
      0,
      SCRIPT_REASON.repeat(4),
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTeam(page);
    for (const id of ['team-import', 'team-history']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(meetsMinTap(box?.height), `${id} is ${String(box?.height)} px high`).toBe(true);
    }
    expect(await scrollsSideways(page)).toBe(false);

    await page.getByTestId('team-history').click();
    const sheet = page.getByRole('dialog', { name: ru('teamConfig.history.title') });
    const row = sheet.getByTestId('history-row-1').getByRole('button');
    await expect(row).toBeVisible();
    expect(meetsMinTap((await row.boundingBox())?.height)).toBe(true);
    expect(await scrollsSideways(page)).toBe(false);
    await row.click();
    await sheet.getByTestId('revision-raw-toggle').click();
    await expect(sheet.getByTestId('revision-raw')).toBeVisible();
    for (const id of ['history-back', 'revision-use', 'revision-raw-toggle']) {
      const box = await sheet.getByTestId(id).boundingBox();
      expect(meetsMinTap(box?.height), `${id} is ${String(box?.height)} px high`).toBe(true);
    }
    expect(await scrollsSideways(page)).toBe(false);
    await expectAccessible(page, 'Settings › Team, revision on the phone');
    await page.keyboard.press('Escape');

    await page.getByTestId('team-import').click();
    const imported = page.getByRole('dialog', { name: ru('teamConfig.import.title') });
    await expect(imported.getByRole('table')).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    for (const id of ['import-use', 'import-cancel']) {
      const box = await imported.getByTestId(id).boundingBox();
      expect(meetsMinTap(box?.height), `${id} is ${String(box?.height)} px high`).toBe(true);
    }
    await expectAccessible(page, 'Settings › Team, import on the phone');
  } finally {
    await api.dispose();
  }
});
