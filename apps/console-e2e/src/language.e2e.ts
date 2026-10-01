import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, test } from './support/fixtures';
import { en, ru } from './support/i18n';

/**
 * The interface language (#4, finding #125): the first launch follows the device language, Settings switches the
 * whole visible UI without a reload, and the choice survives a reload (the PWA restart on iOS is the same page load
 * over the same localStorage). Read-only: nothing here writes to the Worker, so it runs against any target.
 */

type Copy = typeof ru;

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 900;

/** A piece of the shell outside the page: the sidebar's navigation on a wide screen, the top bar's switcher below. */
function shellControl(page: Page, copy: Copy): Locator {
  return isPhone(page)
    ? page.getByRole('button', { name: copy('shell.openSwitcher') })
    : page.getByRole('navigation', { name: copy('shell.nav') });
}

async function expectSettingsIn(page: Page, lang: 'ru' | 'en'): Promise<void> {
  const copy = lang === 'ru' ? ru : en;
  await expect(page.getByRole('heading', { level: 1, name: copy('settings.title') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: copy('settings.projects.title') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: copy('settings.language') })).toBeVisible();
  await expect(shellControl(page, copy)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}

const switchButton = (page: Page): Locator => page.getByTestId('switch-lang');

test.describe('on a Russian device', () => {
  test('starts in Russian; Settings switches to English at once and the choice survives a reload', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expectSettingsIn(page, 'ru');
    await expect(switchButton(page)).toHaveText(ru('settings.switchLang'));
    await expect(switchButton(page)).toHaveAttribute('lang', 'en');

    // No reload: the same document switches, the shell included.
    const before = await page.evaluate(() => performance.timeOrigin);
    await switchButton(page).click();
    await expectSettingsIn(page, 'en');
    expect(await page.evaluate(() => performance.timeOrigin), 'the switch must not reload the page').toBe(
      before,
    );
    await expect(switchButton(page)).toHaveText(en('settings.switchLang'));
    await expect(switchButton(page)).toHaveAttribute('lang', 'ru');
    await expectAccessible(page, 'Settings in English');

    await page.reload();
    await expectSettingsIn(page, 'en');

    // Elsewhere in the app too, after the restart.
    await page.goto('/overview');
    await expect(page.getByRole('heading', { level: 1, name: en('overview.title') })).toBeVisible();

    // And back to Russian, remembered as well.
    await page.goto('/settings');
    await switchButton(page).click();
    await expectSettingsIn(page, 'ru');
    await page.reload();
    await expectSettingsIn(page, 'ru');
  });
});

test.describe('on an English device', () => {
  test.use({ locale: 'en-US' });

  test('the first launch starts in English', async ({ page }) => {
    await page.goto('/settings');
    await expectSettingsIn(page, 'en');
  });
});

test.describe('on a device in another language', () => {
  test.use({ locale: 'de-DE' });

  test('the first launch falls back to English', async ({ page }) => {
    await page.goto('/settings');
    await expectSettingsIn(page, 'en');
  });
});
