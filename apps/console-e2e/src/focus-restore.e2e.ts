import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { fakePost, seed, seedFakeRunLog } from './support/stack';

/**
 * Keyboard focus never falls to <body> or sits on something invisible (#135, #144, #212): Retry on the board's error
 * state, Resume on the paused banner and the page heading on the phone.
 */

const SLUG = 'team-console';
const REPO = `geeera/${SLUG}`;
const LOG = 22;
const BOT = 'team-console-team[bot]';
const DAY = 24 * 60 * 60 * 1000;
const OWNER_PAUSE =
  '<!-- pt-paused -->\n<!-- pt-owner-pause {"reason": "vacation", "source": "team-console"} -->\n' +
  '**Development paused by the owner**';

interface Focused {
  readonly tag: string | null;
  readonly testId: string | null;
  readonly width: number;
}

async function focusedElement(page: Page): Promise<Focused> {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? null,
      testId: element?.getAttribute('data-testid') ?? null,
      width: element?.getBoundingClientRect().width ?? 0,
    };
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, [REPO]);
});

test.afterAll(async ({ stack }) => {
  if (stack.isLocal) {
    await seedFakeRunLog(stack, { author: 'geeera', labels: [] });
  }
});

test('Retry on the board error keeps focus on the new Retry button (#135)', async ({ page }) => {
  await page.route(`**/api/v1/projects/${SLUG}/sprint`, (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'about:blank', title: 'Bad gateway', status: 502 }),
    }),
  );
  await page.goto(`/p/${SLUG}/board`);
  const retry = page.getByTestId('load-error').getByRole('button', { name: ru('ui.error.retry') });
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('load-error')).toBeVisible();
  await expect(retry).toBeFocused();
  expect(await focusedElement(page)).toMatchObject({ tag: 'BUTTON' });
  await expectAccessible(page, 'Board error after Retry');
});

// Set explicitly, not left to the Playwright project: both layouts must keep focus on «Commands» (#862).
const RESUME_VIEWPORTS = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1440, height: 900 } },
] as const;

for (const viewport of RESUME_VIEWPORTS) {
  test(`Resume from the paused banner leaves focus on the Commands button on the ${viewport.name} (#144)`, async ({
    page,
    stack,
  }) => {
    await page.setViewportSize(viewport.size);
    await seedFakeRunLog(stack, { author: BOT, labels: ['team:paused'] });
    const comment = (body: string, author: string, createdAt: number): Promise<unknown> =>
      fakePost(stack, '/_fake/comment', { repo: REPO, number: LOG, body, author, createdAt });
    await comment('<!-- pt-paused -->\n**Team paused**: 3 failed runs in a row.', BOT, Date.now() - 11 * DAY);
    await comment('/resume', 'geeera', Date.now() - 10 * DAY);
    await comment(OWNER_PAUSE, 'geeera', Date.now() - DAY);

    await page.goto(`/p/${SLUG}/questions`);
    const banner = page.getByTestId('paused-banner');
    await expect(banner).toBeVisible();
    await banner.getByTestId('banner-resume').focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog');
    await confirm.locator('.tc-confirm__ok').click();
    await expect(confirm).toHaveCount(0);
    await expect(banner).toHaveCount(0);

    await expect(page.getByTestId('commands-open')).toBeFocused();
    expect(await focusedElement(page)).toMatchObject({ testId: 'commands-open' });
  });
}

test('Settings loads with focus on a heading that can be seen (#212)', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('push-section')).toBeVisible();

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeFocused();
  const focused = await focusedElement(page);
  expect(focused.tag).toBe('H1');
  expect(focused.width).toBeGreaterThan(1);
});
