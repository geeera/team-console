import type { Locator, Page, Route } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Error recovery leads where the fix happens (#366). Settings no longer lists projects (#194), so the console app
 * missing from the repository links to the project's setup page — from a question card, the board and Artifacts —
 * and a missing GitHub connection in the Commands panel offers Connect GitHub. Each way out is one tap and the next
 * stop in tab order after the error text.
 */

const SLUG = 'team-console';
const SETUP_PATH = `/settings/projects/${SLUG}`;
const ISSUE = 90002;
const NOT_INSTALLED = {
  type: 'https://team-console/problems/github-app-not-installed',
  title: 'The console app is not installed on this repository',
  status: 409,
};

function notInstalled(route: Route): Promise<void> {
  return route.fulfill({
    status: 409,
    contentType: 'application/problem+json',
    body: JSON.stringify(NOT_INSTALLED),
  });
}

/** The first element after `text` in document order that Tab would stop at. */
async function nextTabStopAfter(text: Locator): Promise<string | null> {
  return text.evaluate((from) => {
    const candidates = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
      .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0)
      .filter((el) => (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    return candidates[0]?.textContent?.trim() ?? null;
  });
}

async function expectSetupPage(page: Page): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${SETUP_PATH}$`));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const openSetup = ru('settings.setup.openSetup');

test.describe('error recovery (#366)', () => {
  test.beforeEach(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, [`geeera/${SLUG}`]);
  });

  test('a 409 github-app-not-installed on a question card opens the project setup in one tap', async ({ page }) => {
    await page.route(`**/api/v1/projects/${SLUG}/issues/${ISSUE}/answer`, notInstalled);
    await page.goto(`/p/${SLUG}/questions`);
    const card = page.locator(`li[data-number="${ISSUE}"]`);
    await card.locator('[data-command="approve"]').click();

    const block = card.getByTestId('answer-error');
    await expect(block).toHaveAttribute('role', 'alert');
    await expect(block).toContainText(ru('answer.error.app-not-installed'));
    await expect(block).toContainText(ru('answer.error.app-not-installedHint'));
    await expect(block).not.toContainText('Настройки');
    const link = block.getByRole('link', { name: openSetup });
    await expect(link).toHaveAttribute('href', SETUP_PATH);
    expect(await nextTabStopAfter(block.locator('.tc-state-block__description'))).toBe(openSetup);
    await expectAccessible(page, 'Question card, app not installed');

    await link.click();
    await expectSetupPage(page);
  });

  for (const surface of [
    { name: 'board', path: `/p/${SLUG}/board`, api: `**/api/v1/projects/${SLUG}/sprint`, testId: 'load-error' },
    {
      name: 'Artifacts',
      path: `/p/${SLUG}/artifacts`,
      api: new RegExp(`/api/v1/projects/${SLUG}/artifacts(\\?.*)?$`),
      testId: 'artifacts-error',
    },
  ]) {
    test(`the ${surface.name}'s not-installed state opens the project setup in one tap, before Retry`, async ({
      page,
    }) => {
      await page.route(surface.api, notInstalled);
      await page.goto(surface.path);

      const block = page.getByTestId(surface.testId);
      await expect(block).toHaveAttribute('data-failure', 'not-installed');
      await expect(block).toContainText(ru('board.error.not-installed.hint'));
      await expect(block).not.toContainText('«Настройках»');
      const link = block.getByRole('link', { name: openSetup });
      await expect(link).toHaveAttribute('href', SETUP_PATH);
      expect(await nextTabStopAfter(block.locator('.tc-state-block__description'))).toBe(openSetup);
      await expect(block.getByRole('button', { name: ru('ui.error.retry') })).toBeVisible();
      await expectAccessible(page, `${surface.name}, app not installed`);

      await link.click();
      await expectSetupPage(page);
    });
  }

  test('the Commands panel without the owner connection says GitHub is not connected and offers Connect GitHub', async ({
    page,
  }) => {
    await page.route(`**/api/v1/projects/${SLUG}/team/status`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, ownerConnected: false } });
    });
    // The fake stack would leave for github.com; an address that is not GitHub's keeps the owner here with the reason.
    let connectStarted = false;
    await page.route('**/api/v1/github/connect', (route) => {
      connectStarted = true;
      return route.fulfill({ status: 200, json: { authorizeUrl: 'https://example.invalid/authorize' } });
    });
    await page.goto(`/p/${SLUG}/questions`);
    await page.getByTestId('commands-open').click();

    const note = page.getByTestId('cp-not-connected');
    const text = note.locator('[tc-banner-text]');
    await expect(text).toHaveText(ru('commands.status.noperm'));
    await expect(note).not.toContainText('Настройки › Проекты');
    const connect = note.getByRole('button', { name: ru('settings.gh.connect') });
    expect(await nextTabStopAfter(text)).toBe(ru('settings.gh.connect'));
    await expect(page.getByTestId('team-why')).toHaveText(ru('commands.why.noperm'));
    await expect(page.getByTestId('ask-command')).toHaveAttribute('aria-disabled', 'true');
    await expectAccessible(page, 'Commands panel, GitHub not connected');

    await connect.click();
    await expect.poll(() => connectStarted).toBe(true);
    await expect(note.getByRole('alert')).toHaveText(ru('settings.gh.error.url'));
  });
});
