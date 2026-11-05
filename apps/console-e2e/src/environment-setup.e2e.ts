import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed, type Stack } from './support/stack';

/**
 * Environment setup (#104). The local stack's api Worker runs as `local` with its own `--var` flags (AUTH_MODE,
 * GITHUB_MOCK, GITHUB_FAKE_ORIGIN, PUSH_FAKE_ORIGIN; no ROUTINES_FAKE_ORIGIN), so its tab is "this console" and
 * shows set and missing honestly; every other tab is "not visible here". The 403 for the service identity is the
 * api spec's (`routes/environment.spec.ts`): the local stack has no Access.
 */

const isWide = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 900;

/** Values the local api Worker holds; none of them may reach the screen, its storage or the endpoint's body. */
function sentinels(stack: Stack): string[] {
  // GITHUB_FAKE_ORIGIN and ROUTINE_TOKEN_TEAM_CONSOLE as local-stack.ts passes them.
  return [...(stack.fakeURL === null ? [] : [stack.fakeURL]), 'local-fake-routine'];
}

async function expectNoValues(page: Page, stack: Stack): Promise<void> {
  const html = await page.content();
  const storage = await page.evaluate(() =>
    Object.keys(localStorage)
      .map((key) => `${key}=${localStorage.getItem(key) ?? ''}`)
      .join('\n'),
  );
  for (const value of sentinels(stack)) {
    expect(html, `DOM carries ${value}`).not.toContain(value);
    expect(storage, `storage carries ${value}`).not.toContain(value);
  }
}

async function openLocal(page: Page): Promise<void> {
  await page.goto('/settings/environment/local');
  await expect(page.getByRole('heading', { level: 1, name: ru('env.title') })).toBeFocused();
  await expect(page.getByTestId('env-summary')).toContainText(ru('env.sum.ok', { env: 'local' }));
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('Settings has an Environment setup row that opens this console’s environment', async ({ page }) => {
  await page.goto('/settings');
  const section = page.getByTestId('env-section');
  await expect(section.getByRole('heading', { name: ru('env.entry.section') })).toBeVisible();
  await expect(section.getByTestId('env-entry-chip')).toHaveText(ru('env.entry.ok'));
  await expectAccessible(page, 'Settings, Environment row');

  await section.getByRole('link', { name: new RegExp(ru('env.entry.row')) }).click();
  await expect(page).toHaveURL(/\/settings\/environment\/local$/);
  await expect(page.getByRole('heading', { level: 1, name: ru('env.title') })).toBeFocused();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(
    new RegExp(`local\\s*${ru('env.tab.this')}`),
  );
});

test('this console’s tab: set and missing from the Worker, a missing row has its fix with Copy', async ({
  page,
  context,
  stack,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLocal(page);

  const mock = page.locator('[data-row="local/GITHUB_MOCK"]');
  await expect(mock).toHaveAccessibleName(`GITHUB_MOCK, ${ru('env.st.set')}`);
  const missing = page
    .getByTestId('env-row')
    .filter({ has: page.locator('[data-row="local/ROUTINES_FAKE_ORIGIN"]') });
  await expect(missing.getByTestId('env-status')).toHaveText(ru('env.st.missing'));
  await expect(missing).toContainText(ru('env.st.optional'));
  // Missing first in its group.
  await expect(page.locator('[data-group="local"] [data-row]').first()).toHaveAttribute(
    'data-row',
    'local/ROUTINES_FAKE_ORIGIN',
  );
  const fix = missing.getByTestId('env-fix');
  await expect(fix.locator('code')).toHaveText('setup --env local');
  const copy = fix.getByRole('button', { name: ru('env.row.copyAria', { name: 'ROUTINES_FAKE_ORIGIN' }) });
  await copy.click();
  await expect(copy).toContainText(ru('settings.common.copied'));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('setup --env local');

  await expectNoValues(page, stack);
  await expectAccessible(page, 'Environment setup, this console');
});

test('another environment: every item not visible here, per-project tokens with the real slug', async ({
  page,
  stack,
}) => {
  await openLocal(page);
  const selected = page.getByRole('tab', { selected: true });
  await selected.focus();
  // The tabs read dev, stage, production, local: ← from local selects production (automatic activation).
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\/settings\/environment\/production$/);
  await expect(page.getByRole('tab', { selected: true })).toBeFocused();

  const summary = page.getByTestId('env-summary');
  await expect(summary).toContainText(ru('env.sum.other', { this: 'local', env: 'production' }));
  await expect(summary.locator('code')).toHaveText('setup --env production --check');
  const statuses = await page.getByTestId('env-status').allTextContents();
  expect(statuses.length).toBeGreaterThan(10);
  expect(new Set(statuses.map((status) => status.trim()))).toEqual(new Set([ru('env.st.unseen')]));
  await expect(page.getByTestId('env-fix')).toHaveCount(0);

  const project = page.getByTestId('env-project');
  await expect(project.getByRole('button')).toContainText('team-console');
  await project.getByRole('button').click();
  await expect(project.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-row="project/team-console/ROUTINE_TOKEN_TEAM_CONSOLE"]')).toBeVisible();

  await expectNoValues(page, stack);
  await expectAccessible(page, 'Environment setup, another environment');
});

test('a guide: from the manifest only, the command that fits, Back returns to the row', async ({
  page,
  stack,
}) => {
  await page.goto('/settings/environment/production');
  const row = page.locator('[data-row="github-secrets/CLOUDFLARE_API_TOKEN"]');
  await row.click();

  await expect(page).toHaveURL(/\/settings\/environment\/production\/github-secrets\/CLOUDFLARE_API_TOKEN$/);
  const guide = page.getByTestId('env-guide');
  await expect(guide.getByRole('heading', { level: 1, name: 'CLOUDFLARE_API_TOKEN' })).toBeFocused();
  await expect(guide).toContainText(ru('env.g.never'));
  await expect(guide).toContainText('Workers Scripts: Edit');
  await expect(guide.getByTestId('env-guide-status')).toHaveText(ru('env.st.unseen'));
  await expect(guide.getByTestId('env-guide-how').locator('code')).toHaveText([
    'setup --env production --check',
    'setup --env production',
  ]);
  if (isWide(page)) {
    // A pane beside the list; the open row is marked.
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-current', 'page');
  } else {
    await expect(row).toBeHidden();
  }
  await expectNoValues(page, stack);
  await expectAccessible(page, isWide(page) ? 'Environment guide, pane' : 'Environment guide, page');

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/settings\/environment\/production$/);
  await expect(row).toBeFocused();
});

test('the status endpoint carries presence only — no value of any binding', async ({ stack }) => {
  const api = await apiClient(stack);
  try {
    const response = await api.get('/api/v1/environment/status');
    expect(response.status()).toBe(200);
    const text = await response.text();
    for (const value of sentinels(stack)) {
      expect(text).not.toContain(value);
    }
    const body = JSON.parse(text) as { environment: string; items: { id: string; status: string }[] };
    expect(body.environment).toBe('local');
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'optional', 'status']);
      expect(['set', 'missing']).toContain(item.status);
    }
  } finally {
    await api.dispose();
  }
});
