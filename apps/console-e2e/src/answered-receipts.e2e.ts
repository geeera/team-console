import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Answered-question receipts (#328): the card folds into a receipt on «Вопросы» only. «Демо» lists what still waits
 * for the owner and never a receipt. Status is a chip with an icon and words, in the UI sans font.
 */
test.describe.configure({ mode: 'serial' });

const QUESTIONS = '/p/team-console/questions';
const DEMO = '/p/team-console/demo';
const ISSUE = 90002;

const STORYBOOK = 'https://team-console-storybook.pages.dev';

const row = (page: Page, issue: number) => page.locator(`li[data-number="${issue}"]`);

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('«Демо» shows no receipt, «Вопросы» shows the answered one as a chip with icon and meta', async ({
  page,
  outsideRequests,
}) => {
  // The Demo screen frames design previews from the project's Storybook; answer it locally.
  outsideRequests.allow(STORYBOOK);
  await page.route(`${STORYBOOK}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="en"><head><title>Storybook</title></head><body><main><h1>Preview</h1></main></body></html>',
    }),
  );
  await page.goto(QUESTIONS);
  await expect(row(page, ISSUE)).toBeVisible();
  await row(page, ISSUE).locator('[data-command="approve"]').click();

  const receipt = row(page, ISSUE).locator('tc-receipt');
  await expect(receipt).toBeVisible();
  const status = receipt.getByTestId('receipt-status');
  await expect(status).toHaveText(ru('answer.receipt.status.approve'));
  await expect(status.locator('tc-icon')).toBeVisible();
  await expect(receipt).toContainText(`#${ISSUE}`);
  await expect(receipt).toContainText(ru('answer.receipt.waiting'));
  await expect(receipt.getByRole('link', { name: new RegExp(ru('answer.receipt.open')) })).toBeVisible();
  await expect(receipt).toHaveCSS('font-style', 'normal');
  expect(await receipt.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/^"?Source Sans 3/);
  await expectAccessible(page, 'Questions with a receipt');

  await page.goto(DEMO);
  await expect(page.locator('tc-question-list li[data-number]').first()).toBeVisible();
  await expect(page.locator('tc-receipt')).toHaveCount(0);
  await expect(row(page, ISSUE)).toHaveCount(0);
  await expectAccessible(page, 'Demo without receipts');

  await page.goto(QUESTIONS);
  await expect(row(page, ISSUE).locator('tc-receipt')).toBeVisible();
});
