import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { fakeComments, seed } from './support/stack';

/**
 * Approve team recommendations in one go (#220): from Needs you, the safe scope questions (#72, #90007) are listed
 * ticked, the rest left out with the reason; one item GitHub drops stays with Try again; approved cards leave the
 * list and each comment is `backlog answer approve` with the batch's words, written once.
 */
test.describe.configure({ mode: 'serial' });

const SAFE = [72, 90007];
const WORDS = 'Одобряю совет команды (пакетно, 2)';
const item = (page: Page, issue: number) => page.locator(`li[data-number="${issue}"]`);
const BATCH = /\/api\/v1\/projects\/[^/]+\/answers\/batch$/;

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('lists the safe questions ticked and the rest with the reason', async ({ page }) => {
  await page.goto('/needs-you');
  const open = page.getByTestId('batch-approve');
  await expect(open).toHaveText(ru('commands.batch.approve', { n: 2 }));
  await expectAccessible(page, 'Needs you with the batch entry');

  await open.click();
  const dialog = page.getByRole('alertdialog', { name: ru('commands.batch.title') });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('list', { name: ru('commands.batch.list') });
  for (const number of SAFE) {
    await expect(list.locator(`[data-number="${number}"] input`)).toBeChecked();
  }
  await expect(list.locator('tc-check-row')).toHaveCount(2);

  const out = dialog.getByTestId('batch-left-out');
  await out.locator('summary').click();
  await expect(out.locator('li[data-number="90002"]')).toContainText(ru('commands.batch.why.design'));
  await expect(out.locator('li[data-number="90001"]')).toContainText(ru('commands.batch.why.untrusted'));
  await expect(out.locator('li[data-number="90005"]')).toContainText(ru('commands.batch.why.release'));
  await expect(dialog).toContainText(`«${WORDS}»`);
  await expectAccessible(page, 'batch dialog');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('one dropped item stays with Try again; approved cards leave Needs you, each written once', async ({
  page,
  stack,
}) => {
  const before = await Promise.all(SAFE.map(async (number) => (await fakeComments(stack, number)).length));
  let posts = 0;
  await page.route(BATCH, async (route) => {
    posts += 1;
    const response = await route.fetch();
    if (posts > 1) {
      await route.fulfill({ response });
      return;
    }
    // The Worker wrote both; the answer says GitHub dropped #90007, as a 502 on its comment would.
    const body = (await response.json()) as { results: { number: number }[] };
    const results = body.results.map((result) =>
      result.number === 90007
        ? {
            number: 90007,
            ok: false,
            problem: { type: 'https://team-console/problems/github-unavailable', title: 'x', status: 502 },
          }
        : result,
    );
    await route.fulfill({ response, json: { results } });
  });
  await page.goto('/needs-you');
  await page.getByTestId('batch-approve').click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByTestId('batch-ok').click();

  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('Одобрено 1 из 2');
  await expect(dialog.locator('tc-check-row')).toHaveCount(1);
  await expect(dialog.locator('tc-check-row[data-number="90007"]')).toBeVisible();
  await expect(dialog.getByTestId('batch-ok')).toHaveText(ru('commands.batch.retry'));
  await expectAccessible(page, 'batch dialog after a partial failure');

  await dialog.getByTestId('batch-ok').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('batch-receipt')).toContainText(ru('commands.batch.done', { n: 2 }));
  await expect(page.getByTestId('batch-receipt')).toBeFocused();
  for (const number of SAFE) {
    await expect(item(page, number)).toHaveCount(0);
  }
  expect(posts).toBe(2);

  // The retry repeated the same words, so the Worker replayed #90007 instead of posting it again.
  for (const [index, number] of SAFE.entries()) {
    const comments = await fakeComments(stack, number);
    expect(comments).toHaveLength((before[index] ?? 0) + 1);
    expect(comments.at(-1)?.author).toBe('geeera');
    expect(comments.at(-1)?.body).toBe(
      `/approve\n\n_Answered by the owner in the team console: «${WORDS}»_\n`,
    );
  }

  // Nothing safe is left: the entry stays, off, and says so.
  const empty = page.getByTestId('batch-approve');
  await expect(empty).toHaveText(ru('commands.batch.approveNone'));
  await expect(empty).toHaveAttribute('aria-disabled', 'true');
  await expectAccessible(page, 'Needs you after the batch');

  // Read again from the server: the approved cards stay out.
  await page.reload();
  await expect(item(page, 90002)).toBeVisible();
  for (const number of SAFE) {
    await expect(item(page, number)).toHaveCount(0);
  }
});
