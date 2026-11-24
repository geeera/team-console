import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { appNameOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { environmentOf, seed } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * The install prompt after sign-in (#761): the card on the landing screen (one tap in Chromium with a synthetic
 * `beforeinstallprompt`, the Home Screen steps on iPhone Safari), its snooze, never and the automatic snooze after
 * three ignored launches, the installed app, the phone's bottom bar (#368) and Settings › App.
 */

const KEY = 'tc.install-prompt.v1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DAY_MS = 24 * 60 * 60 * 1000;

test.use({ installPrompt: 'fresh' });

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

const isProject = (page: Page, name: string): boolean => test.info().project.name === name;
const card = (page: Page): Locator => page.getByTestId('install-card');
const heading = (page: Page): Locator => page.getByRole('heading', { level: 1, name: ru('needsYou.title') });
const stored = (page: Page): Promise<unknown> =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }, KEY);

/**
 * The name the app gives itself here («Team Console Local» on the local stack): the title it sets once the Worker has
 * said where it runs (#237). index.html's static «Team Console» is there first, so the spec waits for the exact name
 * instead of reading whatever title is up (#947).
 */
async function appName(page: Page, request: APIRequestContext): Promise<string> {
  const name = appNameOf(await environmentOf(request));
  await expect(page).toHaveTitle(name);
  return name;
}

/**
 * Chromium's install event, dispatched once the page's scripts ran (main.ts keeps it before Angular starts); its
 * `prompt()` records the call and `userChoice` answers `outcome`, or `prompt()` throws.
 */
async function offerNativeInstall(page: Page, outcome: 'accepted' | 'dismissed' | 'throws'): Promise<void> {
  await page.addInitScript((answer) => {
    window.addEventListener('DOMContentLoaded', () => {
      const record = { prompted: 0 };
      Object.assign(window, { tcInstallRecord: record });
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => {
          record.prompted += 1;
          if (answer === 'throws') {
            throw new DOMException('not allowed', 'NotAllowedError');
          }
        },
        userChoice: Promise.resolve({ outcome: answer === 'throws' ? 'dismissed' : answer }),
      });
      window.dispatchEvent(event);
    });
  }, outcome);
}

const promptedTimes = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { tcInstallRecord?: { prompted: number } }).tcInstallRecord?.prompted ?? 0);

async function expectTapTargets(targets: readonly Locator[]): Promise<void> {
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(meetsMinTap(box?.height), 'tap height').toBe(true);
    expect(meetsMinTap(box?.width), 'tap width').toBe(true);
  }
}

test.describe('Chromium: one tap to the native dialog', () => {
  test.use({ userAgent: ANDROID_CHROME });

  test('the card on Needs you holds the push nudge, and Install opens the dialog to the success line', async ({
    page,
    request,
  }) => {
    await offerNativeInstall(page, 'accepted');
    await page.goto('/needs-you');
    const name = await appName(page, request);

    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(ru('install.card.title', { app: name }));
    await expect(page.getByTestId('push-nudge')).toHaveCount(0);
    expect(await card(page).evaluate((element) => getComputedStyle(element).position)).toBe('static');
    const install = card(page).getByTestId('install-card-install');
    await expect(install).toHaveAccessibleName(ru('install.card.installAria', { app: name }));
    if (isProject(page, 'iphone')) {
      await expectTapTargets([install, card(page).getByTestId('install-card-later'), card(page).getByTestId('install-card-never')]);
    }
    await expectAccessible(page, 'Needs you with the install card (Chromium)');
    expect(await stored(page)).toEqual({ ignored: 1 });

    await install.click();

    const done = page.getByTestId('install-card-done');
    await expect(done).toHaveAttribute('role', 'status');
    await expect(done).toBeFocused();
    await expect(done).toContainText(name);
    expect(await promptedTimes(page)).toBe(1);
    expect(await stored(page)).toBeNull();
    await expectAccessible(page, 'Needs you, install accepted');

    await done.getByTestId('install-card-done-close').click();
    await expect(done).toHaveCount(0);
    await expect(heading(page)).toBeFocused();
  });

  // Outside iOS the e2e browser has no working push (service workers are blocked), so the nudge's return after a
  // snooze is checked on the iPhone path below.
  test('a dismissed dialog snoozes for 14 days with the toast and no card on the next launch', async ({
    page,
  }) => {
    await offerNativeInstall(page, 'dismissed');
    await page.goto('/needs-you');
    await card(page).getByTestId('install-card-install').click();

    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: ru('install.toast') })).toBeVisible();
    await expect(heading(page)).toBeFocused();
    const memory = (await stored(page)) as { choice: string; until: string };
    expect(memory.choice).toBe('snoozed');
    const days = (Date.parse(memory.until) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);

    await page.reload();
    await expect(page.locator('li[data-number]').first()).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('a dialog that cannot open keeps the card with an alert and the browser menu', async ({ page }) => {
    await offerNativeInstall(page, 'throws');
    await page.goto('/needs-you');
    const install = card(page).getByTestId('install-card-install');
    await install.click();

    await expect(card(page).getByRole('alert')).toHaveText(ru('install.card.error'));
    await expect(install).toBeFocused();
    await expectAccessible(page, 'Needs you, install window failed');
  });
});

test.describe('Chromium: a late install event', () => {
  test.use({ userAgent: MAC_CHROME });

  test('is not inserted above the screen being read; it shows on the next screen opened', async ({ page }) => {
    test.skip(!isProject(page, 'desktop'), 'the sidebar is the wide-screen way to the next screen');
    await page.goto('/needs-you');
    await expect(page.locator('li[data-number]').first()).toBeVisible();
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => undefined,
        userChoice: Promise.resolve({ outcome: 'dismissed' }),
      });
      window.dispatchEvent(event);
    });
    // Give the app a frame to (wrongly) react before asserting the absence.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    await expect(card(page)).toHaveCount(0);

    await page
      .getByRole('navigation', { name: ru('shell.nav') })
      .getByRole('button', { name: /^team-console(\s|$)/ })
      .click();
    await expect(page).toHaveURL(/\/p\/team-console\//);
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByTestId('install-card-install')).toBeVisible();
  });
});

test.describe('iPhone Safari: the Home Screen guide', () => {
  test('How to install opens the three steps inside the card; Not now snoozes and focuses the heading', async ({
    page,
    request,
  }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.goto('/needs-you');
    const name = await appName(page, request);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText(ru('install.card.bodyIos'));
    await expect(page.getByTestId('push-nudge')).toHaveCount(0);
    const how = card(page).getByTestId('install-card-how');
    await expect(how).toHaveAttribute('aria-expanded', 'false');

    await how.click();

    await expect(how).toHaveAttribute('aria-expanded', 'true');
    await expect(how).toBeFocused();
    const guide = card(page).getByTestId('push-install-guide');
    await expect(guide).toHaveAttribute('id', (await how.getAttribute('aria-controls')) ?? 'missing');
    await expect(guide.locator('li')).toHaveCount(3);
    await expect(guide.locator('li').nth(2)).toContainText(ru('install.guide.s3', { app: name }));
    await expectTapTargets([how, card(page).getByTestId('install-card-later'), card(page).getByTestId('install-card-never')]);
    await expectAccessible(page, 'Needs you, iPhone steps open');

    await card(page).getByTestId('install-card-later').click();
    await expect(card(page)).toHaveCount(0);
    await expect(heading(page)).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: ru('install.toast') })).toBeVisible();
  });

  test('a snooze holds across a reload and ends with the clock 15 days on', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.goto('/needs-you');
    await card(page).getByTestId('install-card-later').click();
    await page.reload();
    await expect(page.getByTestId('push-nudge')).toBeVisible();
    await expect(card(page)).toHaveCount(0);

    await page.addInitScript((shift) => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + shift;
    }, 15 * DAY_MS);
    await page.reload();
    await expect(card(page)).toBeVisible();
  });

  test('Don’t show again holds for good', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.goto('/needs-you');
    await card(page).getByTestId('install-card-never').click();
    await expect(heading(page)).toBeFocused();
    expect(await stored(page)).toEqual({ choice: 'never' });

    await page.addInitScript((shift) => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + shift;
    }, 365 * DAY_MS);
    await page.reload();
    await expect(page.getByTestId('push-nudge')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('three ignored launches snooze it on the fourth, without a toast', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    for (let launch = 1; launch <= 3; launch += 1) {
      if (launch === 1) {
        await page.goto('/needs-you');
      } else {
        await page.reload();
      }
      await expect(card(page)).toBeVisible();
      await expect.poll(() => stored(page)).toEqual({ ignored: launch });
    }

    await page.reload();
    await expect(page.getByTestId('push-nudge')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: ru('install.toast') })).toHaveCount(0);
    expect(await stored(page)).toMatchObject({ choice: 'snoozed', auto: true });
  });

  test('with storage refusing writes nothing breaks and Not now holds until the reload', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('quota', 'QuotaExceededError');
      };
    });
    await page.goto('/needs-you');
    await card(page).getByTestId('install-card-later').click();
    await expect(card(page)).toHaveCount(0);

    await page.reload();
    await expect(card(page)).toBeVisible();
  });

  test('in a project space the card stays in the flow and every bottom tab stays clickable (#368)', async ({
    page,
  }) => {
    test.skip(!isProject(page, 'iphone'), 'the bottom tab bar is the phone layout');
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/p/team-console/board');
      await expect(card(page)).toBeVisible();
      expect(await card(page).evaluate((element) => getComputedStyle(element.parentElement ?? element).position)).toBe(
        'static',
      );
      expect(await card(page).evaluate((element) => getComputedStyle(element).position)).toBe('static');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const tabs = page.locator('nav.tc-tab-bar--bottom a');
      const count = await tabs.count();
      expect(count).toBeGreaterThan(1);
      for (let index = 0; index < count; index += 1) {
        const covered = await tabs.nth(index).evaluate((tab) => {
          const box = tab.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return hit === null || !tab.contains(hit);
        });
        expect(covered, `tab ${index} at ${width} px`).toBe(false);
      }
      await expectAccessible(page, `Board with the install card at ${width} px`);
      await page.evaluate((key) => localStorage.removeItem(key), KEY);
    }
  });

  test('under reduced motion the card appears without animation', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/needs-you');
    const duration = await card(page).evaluate((element) => parseFloat(getComputedStyle(element).animationDuration) * 1000);
    expect(duration).toBeLessThanOrEqual(1);
  });

  test('the English card reads in English', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.addInitScript(() => localStorage.setItem('tc.lang.v1', 'en'));
    await page.goto('/needs-you');
    await expect(card(page)).toContainText(en('install.card.bodyIos'));
    await expectAccessible(page, 'Needs you with the install card (en)');
  });
});

test.describe('the installed app', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
    });
  });

  test('shows no card, and Settings › App says installed with no action', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Home Screen app');
    await page.goto('/needs-you');
    await expect(page.locator('li[data-number]').first()).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(await stored(page)).toBeNull();

    await page.goto('/settings');
    const section = page.getByTestId('app-section');
    await expect(section.getByTestId('install-entry-chip')).toHaveText(ru('settings.app.chipOn'));
    await expect(section.getByRole('button')).toHaveCount(0);
    await expectAccessible(page, 'Settings › App in the installed app');
  });
});

test.describe('Settings › App', () => {
  test('sits between GitHub and Notifications; on iPhone Safari the steps live there only once', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.goto('/settings');
    await expect(page.getByTestId('push-section')).toBeVisible();
    const titles = await page.locator('h2').allTextContents();
    const at = (title: string): number => titles.map((text) => text.trim()).indexOf(title);
    expect(at(ru('settings.app.title'))).toBe(at(ru('settings.gh.title')) + 1);
    expect(at(ru('push.title'))).toBe(at(ru('settings.app.title')) + 1);
    await expect(page.getByTestId('install-entry-chip')).toHaveText(ru('settings.app.chipOff'));
    await expect(page.getByTestId('push-install-guide')).toHaveCount(0);

    await page.getByTestId('push-go-to-app').click();

    await expect(page.getByRole('heading', { level: 2, name: ru('settings.app.title') })).toBeFocused();
    await expect(page.getByTestId('push-install-guide')).toHaveCount(1);
    await expect(page.getByTestId('install-settings-how')).toHaveAttribute('aria-expanded', 'true');
    await expectAccessible(page, 'Settings › App, iPhone steps open');
  });

  test('the push nudge’s How to turn on leads there with the steps open', async ({ page }) => {
    test.skip(!isProject(page, 'iphone'), 'the iPhone Safari agent');
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ choice: 'never' })), KEY);
    await page.goto('/needs-you');
    await page.getByTestId('push-nudge-how').click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 2, name: ru('settings.app.title') })).toBeFocused();
    await expect(page.getByTestId('push-install-guide')).toHaveCount(1);
  });

  test.describe('in Chromium with the event kept', () => {
    test.use({ userAgent: ANDROID_CHROME });

    test('Install from Settings, then it says installed in this tab', async ({ page, request }) => {
      await offerNativeInstall(page, 'accepted');
      await page.goto('/settings');
      const section = page.getByTestId('app-section');
      await expect(section.getByTestId('install-entry-sub')).toHaveText(ru('settings.app.subNative'));
      await expectAccessible(page, 'Settings › App, can install');

      await section.getByTestId('install-settings-install').click();

      const name = await appName(page, request);
      await expect(section.getByTestId('install-entry-sub')).toHaveText(ru('settings.app.subJustInstalled', { app: name }));
      await expect(section.getByTestId('install-entry-chip')).toHaveText(ru('settings.app.chipOn'));
      await expect(page.getByRole('heading', { level: 2, name: ru('settings.app.title') })).toBeFocused();
    });
  });
});
