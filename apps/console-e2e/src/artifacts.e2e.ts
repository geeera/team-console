import type { Page } from '@playwright/test';
import type { ArtifactsResponse } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Artifacts (#19): every decision, design and demo of the fixture repository from one request, type toggles and a
 * search over the loaded list (state in the URL), the no-match state, the keyboard, and axe.
 */

const ARTIFACTS = '/api/v1/projects/team-console/artifacts';

function typeButton(page: Page, key: string) {
  return page.locator(`[data-testid="artifact-type"][data-type="${key}"]`);
}

test.describe('the Artifacts section', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console']);
  });

  test('lists every artifact, filters by type and by words, and recovers from no match', async ({
    page,
    request,
  }) => {
    const body = (await (await request.get(ARTIFACTS)).json()) as ArtifactsResponse;
    const decisions = body.items.filter((item) => item.type === 'decision');
    expect(body.partial, 'the fixture repository reads completely').toBeUndefined();
    expect(decisions.length, 'the fixture repository has decision records').toBeGreaterThan(0);
    expect(body.items.every((item) => item.url.startsWith('https://github.com/'))).toBe(true);

    await page.goto('/p/team-console/artifacts');
    await expect(page.getByRole('heading', { level: 2, name: ru('artifacts.title') })).toBeVisible();
    const rows = page.getByTestId('artifact');
    await expect(rows).toHaveCount(body.items.length);
    await expect(typeButton(page, 'all')).toHaveAttribute('aria-pressed', 'true');
    await expectAccessible(page, 'Artifacts');

    await typeButton(page, 'decision').click();
    await expect(typeButton(page, 'decision')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(decisions.length);
    await expect(page).toHaveURL(/[?&]type=decision/);
    // Links open GitHub in a new tab; nothing on the page navigates off the app.
    await expect(rows.first().locator('a')).toHaveAttribute('target', '_blank');

    const query = page.getByLabel(ru('artifacts.search'));
    await query.fill('Paper Desk');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Paper Desk');
    await expect(page).toHaveURL(/[?&]q=Paper/);

    await query.fill('nothing like this anywhere');
    await expect(page.getByTestId('artifacts-no-match')).toBeVisible();
    await expectAccessible(page, 'Artifacts, no match');
    await page.getByRole('button', { name: ru('artifacts.noMatch.clear') }).click();
    await expect(rows).toHaveCount(body.items.length);
    await expect(query).toHaveValue('');
  });

  test('the keyboard reaches the type toggles, and a reload keeps the filter from the URL', async ({
    page,
  }) => {
    await page.goto('/p/team-console/artifacts');
    const rows = page.getByTestId('artifact');
    await expect(rows.first()).toBeVisible();

    await page.getByLabel(ru('artifacts.search')).focus();
    let reached = false;
    for (let step = 0; step < 6 && !reached; step += 1) {
      await page.keyboard.press('Tab');
      reached = await typeButton(page, 'demo').evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'Tab reaches the Demo toggle').toBe(true);
    await page.keyboard.press('Enter');
    await expect(typeButton(page, 'demo')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first()).toHaveAttribute('data-type', 'demo');

    await page.reload();
    await expect(typeButton(page, 'demo')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first()).toHaveAttribute('data-type', 'demo');
  });

  /**
   * #295 (#277 spec §4): the Design filter has its own list states. The artifacts answer is held back in the browser
   * until the loading state has been checked, then released without its design issues.
   */
  test('the Design filter loads as skeleton rows with «Загружаем дизайны…» and says «Дизайнов пока нет» without designs', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/v1\/projects\/team-console\/artifacts(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as ArtifactsResponse;
      await held;
      await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.type !== 'design') } });
    });

    await page.goto('/p/team-console/artifacts?type=design');
    const loading = page.getByTestId('artifacts-designs-loading');
    await expect(loading).toBeVisible();
    await expect(loading.getByRole('status')).toHaveText(ru('artifacts.designs.loading'));
    await expect(loading.locator('.artifacts__skeleton')).toHaveCount(3);
    await expect(page.getByTestId('artifacts-loading')).toHaveCount(0);
    await expectAccessible(page, 'Artifacts → Design, loading');

    release();
    const empty = page.getByTestId('artifacts-designs-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(ru('artifacts.designs.empty.title'));
    await expect(empty).toContainText(ru('artifacts.designs.empty.hint'));
    await expect(page.getByTestId('artifacts-no-match')).toHaveCount(0);
    await expect(page.getByTestId('artifacts-empty')).toHaveCount(0);
    // The type toggles stay, so the owner can move on to the other artifacts.
    await expect(typeButton(page, 'design')).toHaveAttribute('aria-pressed', 'true');
    await expectAccessible(page, 'Artifacts → Design, empty');

    await typeButton(page, 'all').click();
    await expect(page.getByTestId('artifact').first()).toBeVisible();
    await expect(empty).toHaveCount(0);
  });

  test('"Check again" asks the Worker for a fresh read', async ({ page }) => {
    await page.goto('/p/team-console/artifacts');
    await expect(page.getByTestId('artifact').first()).toBeVisible();
    const fresh = page.waitForRequest((sent) => new URL(sent.url()).search === '?fresh=1');
    await page.getByTestId('artifacts-check-again').click();
    await fresh;
    await expect(page.getByTestId('artifact').first()).toBeVisible();
  });
});
