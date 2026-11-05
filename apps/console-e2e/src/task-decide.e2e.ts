import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, localD1, switchToConsoleTracker } from './support/tracker-seed';

/**
 * Decide on a console-tracker item (#435, #409 §2.1): Approve / Reject by button on the task screen and in Needs you,
 * recorded as an owner decision that names the open ask (#443); a comment is never one. Asks are job writes (Phase 2),
 * so the spec writes the open ask into the worker's local D1, as a team role will.
 */

const SLUG = 'team-console';
let number = 0;

async function askOn(workerIndex: number, item: number, text: string): Promise<void> {
  await localD1(
    workerIndex,
    `INSERT INTO asks (project_slug, item_id, category, ask, commands, recommended, created_at, source)
     SELECT '${SLUG}', id, 'scope', '${text}', '["approve","reject"]', 'approve', '2026-11-05T09:00:00.000Z', 'console'
     FROM items WHERE project_slug = '${SLUG}' AND number = ${String(item)}`,
  );
}

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
});

test.beforeEach(async ({ stack }, testInfo) => {
  const api = await apiClient(stack);
  try {
    number = await createItem(api, SLUG, { title: 'A paper sound on the stamp', kind: 'question' });
  } finally {
    await api.dispose();
  }
  await askOn(testInfo.workerIndex, number, 'Take the stamp sound into the next sprint?');
});

async function openTask(page: Page): Promise<void> {
  await page.goto(`/p/${SLUG}/t/${String(number)}`);
  await expect(page.getByTestId('task-title')).toBeFocused();
}

test('Approve on the task screen records a decision naming the open ask', async ({ page }) => {
  const sent: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/items/${String(number)}/decisions`)) {
      sent.push(request.postDataJSON());
    }
  });
  await openTask(page);
  const card = page.getByTestId('task-decision');
  await expect(card).toContainText('Take the stamp sound into the next sprint?');
  await expect(card).toContainText(`TC-${String(number)}`);
  await expectAccessible(page, 'task with a decision waiting');
  await card.getByRole('button', { name: ru('answer.command.approve') }).click();
  const receipt = page.getByTestId('task-decision-receipt');
  await expect(receipt).toContainText(ru('answer.receipt.status.approve'));
  await expect(receipt.locator('.tc-task-decision__verb')).toBeFocused();
  await expect(page.getByTestId('task-history')).toContainText(ru('item.ev.approved'));
  expect(sent).toEqual([
    expect.objectContaining({ command: 'approve', askId: expect.any(Number), via: 'web' }),
  ]);
});

test('Reject needs a reason, and the reason lands in History', async ({ page }) => {
  await openTask(page);
  await page
    .getByTestId('task-decision')
    .getByRole('button', { name: ru('answer.command.reject') })
    .click();
  const sheet = page.getByRole('dialog', { name: ru('answer.reason.title.reject') });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox').fill('Not before the demo');
  await sheet.getByRole('button', { name: ru('answer.reason.submit.reject') }).click();
  await expect(page.getByTestId('task-decision-receipt')).toContainText(ru('answer.receipt.status.reject'));
  await expect(page.getByTestId('task-history')).toContainText('Отклонено: «Not before the demo»');
});

test('a question replaced after the screen was read is no longer waiting', async ({ page }, testInfo) => {
  await openTask(page);
  await localD1(
    testInfo.workerIndex,
    `UPDATE asks SET withdrawn_at = '2026-11-05T10:00:00.000Z' WHERE answered_by_decision_id IS NULL
     AND withdrawn_at IS NULL AND item_id = (SELECT id FROM items WHERE project_slug = '${SLUG}' AND number = ${String(number)})`,
  );
  await askOn(testInfo.workerIndex, number, 'A newer question');
  await page
    .getByTestId('task-decision')
    .getByRole('button', { name: ru('answer.command.approve') })
    .click();
  const error = page.getByTestId('answer-error');
  await expect(error).toHaveAttribute('data-kind', 'not-waiting');
  await error.getByRole('button', { name: ru('answer.error.refresh') }).click();
  await expect(page.getByTestId('task-decision')).toContainText('A newer question');
});

test('Needs you answers a console item with a decision and links its task', async ({ page }) => {
  await page.goto('/needs-you');
  const card = page.locator(`li[data-number="${String(number)}"]`);
  await expect(card).toContainText(`TC-${String(number)}`);
  await expect(card.getByTestId('open-task')).toHaveAttribute('href', `/p/${SLUG}/t/${String(number)}`);
  const decided = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith(`/items/${String(number)}/decisions`),
  );
  await card.getByRole('button', { name: ru('answer.command.approve') }).click();
  expect((await decided).headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  await expect(
    page.locator(`[data-receipt="${SLUG}#${String(number)}"]`).getByTestId('receipt-task'),
  ).toBeVisible();
  await expectAccessible(page, 'needs you after a decision');
});
