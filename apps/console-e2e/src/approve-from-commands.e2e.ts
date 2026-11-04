import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { fakeComments, seed } from './support/stack';

/**
 * Approve team recommendations from the Commands panel (#246): the panel (the pane at 1440 px, the sheet at 390 px)
 * has the row with the count Needs you shows for the project, and «Посмотреть» opens the same batch dialog; Escape
 * returns focus to the button, and an approved batch is written once per item, after which the row says there is
 * nothing to batch. The mock's safe scope questions are #72 and #90007 (as in batch-approve.e2e.ts).
 */
test.describe.configure({ mode: 'serial' });

const SAFE = [72, 90007];
const BATCH = /\/api\/v1\/projects\/team-console\/answers\/batch$/;

async function openPanel(page: Page): Promise<void> {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('issues-group')).toBeVisible();
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('the row counts what Needs you would batch, and Review opens the same dialog', async ({ page }) => {
  await page.goto('/needs-you');
  await expect(page.getByTestId('batch-approve')).toHaveText(
    ru('commands.batch.approve', { n: SAFE.length }),
  );

  await openPanel(page);
  const row = page.getByTestId('approve-row');
  await expect(row).toContainText(ru('commands.approve.title'));
  await expect(page.getByTestId('approve-hint')).toContainText(`${SAFE.length} `);
  const review = row.getByRole('button', { name: ru('commands.approve.aria', { n: SAFE.length }) });
  await expect(review).toHaveText(ru('commands.approve.btn'));
  await expectAccessible(page, 'Commands panel with the batch row');

  await review.click();
  const dialog = page.getByRole('alertdialog', { name: ru('commands.batch.title') });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('list', { name: ru('commands.batch.list') });
  for (const number of SAFE) {
    await expect(list.locator(`[data-number="${number}"] input`)).toBeChecked();
  }
  await expect(list.locator('tc-check-row')).toHaveCount(SAFE.length);
  await expectAccessible(page, 'batch dialog opened from the Commands panel');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(review).toBeFocused();
  // Escape closed only the batch dialog: the panel (a sheet on the phone) is still open.
  await expect(row).toBeVisible();
});

test('approving from the panel writes each answer once; then the row has nothing to batch', async ({
  page,
  stack,
}) => {
  const before = await Promise.all(SAFE.map(async (number) => (await fakeComments(stack, number)).length));
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && BATCH.test(new URL(request.url()).pathname)) {
      posts += 1;
    }
  });
  await openPanel(page);
  await page.getByTestId('approve-command').click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByTestId('batch-ok').click();
  await expect(dialog).toBeHidden();

  const result = page.locator('.cp-result');
  await expect(result).toContainText(ru('commands.batch.done', { n: SAFE.length }));
  await expect(result).toBeFocused();
  await expect(page.getByTestId('approve-line')).toHaveText(ru('commands.approve.none'));
  await expect(page.getByTestId('approve-row').getByRole('button')).toHaveCount(0);
  await expectAccessible(page, 'Commands panel after the batch');
  expect(posts).toBe(1);

  for (const [index, number] of SAFE.entries()) {
    expect(await fakeComments(stack, number)).toHaveLength((before[index] ?? 0) + 1);
  }

  // Needs you on this device agrees: nothing safe is left to batch.
  await page.goto('/needs-you');
  await expect(page.getByTestId('batch-approve')).toHaveText(ru('commands.batch.approveNone'));
});
