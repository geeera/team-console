import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, patchItem, switchToConsoleTracker } from './support/tracker-seed';

/**
 * The task screen (#435, #409 §2.1): read, edit title and details, status and kind pickers, History, comments, the
 * conflict when someone changed the task meanwhile, and the write failures. team-console is moved onto the console
 * tracker (key TC) for these specs; its items are created through the owner's API.
 */

const SLUG = 'team-console';
let number = 0;

let sprint = 0;

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    sprint = await createSprint(api, SLUG, '2030-01-15');
  } finally {
    await api.dispose();
  }
});

// A fresh task per test, so each test reads its own History; it is the newest, so the last in its lane.
test.beforeEach(async ({ stack }) => {
  const api = await apiClient(stack);
  try {
    number = await createItem(api, SLUG, {
      title: 'Answer not saved on a slow network',
      body: 'On a slow network the answer goes out twice.',
      kind: 'bug',
      status: 'approved',
      sprint,
    });
  } finally {
    await api.dispose();
  }
});

async function openTask(page: Page): Promise<void> {
  await page.goto(`/p/${SLUG}/t/${String(number)}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Answer not saved on a slow network' }),
  ).toBeFocused();
}

test('opens the task with its fields, details and history, focused on the title', async ({ page }) => {
  await openTask(page);
  await expect(page.getByText(`TC-${String(number)}`).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: `${ru('item.status')}: ${ru('board.status.approved')}` }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `${ru('item.kind')}: ${ru('board.kind.bug')}` }),
  ).toBeVisible();
  await expect(page.getByTestId('pick-sprint')).toHaveAccessibleName(/^Спринт: Sprint 01 — текущий/);
  await expect(page.getByTestId('task-queue')).toHaveText(/^(\d+)-я из \1 в «Одобрено»$/);
  await expect(page.getByTestId('task-details')).toHaveText('On a slow network the answer goes out twice.');
  await expect(page.getByTestId('task-history')).toContainText(ru('item.ev.created'));
  await expectAccessible(page, 'task loaded');
});

test('edits the title and details together and records it in History', async ({ page }) => {
  await openTask(page);
  await page.getByRole('button', { name: ru('item.editAria') }).click();
  const title = page.getByTestId('edit-title');
  await expect(title).toBeFocused();
  await title.fill('Answer saved once on a slow network');
  await page.getByTestId('edit-body').fill('Retry reuses the idempotency key.');
  await expectAccessible(page, 'task editing');
  await page.getByTestId('edit-save').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Answer saved once on a slow network' }),
  ).toBeFocused();
  await expect(page.getByTestId('task-details')).toHaveText('Retry reuses the idempotency key.');
  await expect(page.getByTestId('task-history')).toContainText(ru('item.ev.edit'));
});

test('keeps an unsaved edit on the device across a reload, and asks before discarding it', async ({
  page,
}) => {
  await openTask(page);
  await page.getByRole('button', { name: ru('item.editAria') }).click();
  await page.getByTestId('edit-title').fill('A draft title');
  await page.reload();
  await page.getByRole('button', { name: ru('item.editAria') }).click();
  await expect(page.getByTestId('edit-title')).toHaveValue('A draft title');
  await expect(page.getByTestId('edit-draft')).toBeVisible();
  await page.getByTestId('edit-cancel').click();
  const dialog = page.getByRole('alertdialog', { name: ru('item.discard.title') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: ru('item.discard.ok') }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Answer not saved on a slow network' }),
  ).toBeVisible();
});

test('a status pick saves at once, keeps focus on the picker and lands in History', async ({ page }) => {
  await openTask(page);
  const status = page.getByRole('button', { name: `${ru('item.status')}: ${ru('board.status.approved')}` });
  await status.click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitemradio', { name: new RegExp(ru('board.status.approved')) }),
  ).toBeFocused();
  await expectAccessible(page, 'status picker open');
  await menu.getByRole('menuitemradio', { name: new RegExp(`^${ru('board.status.qa')}`) }).click();
  const changed = page.getByRole('button', { name: `${ru('item.status')}: ${ru('board.status.qa')}` });
  await expect(changed).toBeFocused();
  await expect(page.getByTestId('task-history')).toContainText('Статус: Одобрено → Проверка');
});

test('a comment that reads like /approve is only a comment, and says so', async ({ page }) => {
  await openTask(page);
  const box = page.getByLabel(ru('item.comment'));
  await box.fill('/approve please');
  await expect(page.getByTestId('comment-command-note')).toHaveText(ru('item.commentCmdNoDecision'));
  await page.getByTestId('comment-send').click();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(page.getByTestId('task-history')).toContainText('/approve please');
  // The status is untouched: a comment never approves anything.
  await expect(
    page.getByRole('button', { name: `${ru('item.status')}: ${ru('board.status.approved')}` }),
  ).toBeVisible();
});

test('a save over a newer version keeps the owner’s text and can save it over theirs', async ({
  page,
  stack,
}) => {
  await openTask(page);
  await page.getByRole('button', { name: ru('item.editAria') }).click();
  await page.getByTestId('edit-body').fill('My details');
  const api = await apiClient(stack);
  try {
    await patchItem(api, SLUG, number, { body: 'The PM’s details' });
  } finally {
    await api.dispose();
  }
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('edit-conflict')).toContainText(ru('item.err.conflict.title'));
  await expect(page.getByTestId('edit-body')).toHaveValue('My details');
  await page.getByRole('button', { name: ru('item.err.conflict.see') }).click();
  await expect(page.getByTestId('edit-theirs')).toContainText('The PM’s details');
  await expectAccessible(page, 'task conflict');
  await page.getByRole('button', { name: ru('item.err.conflict.mine') }).click();
  await expect(page.getByTestId('task-details')).toHaveText('My details');
});

test('a dropped write is retried with the same idempotency key, a 403 says only the owner may', async ({
  page,
}) => {
  await openTask(page);
  const keys: string[] = [];
  let calls = 0;
  await page.route(`**/api/v1/projects/${SLUG}/items/${String(number)}/comments`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    calls += 1;
    if (calls === 1) {
      await route.abort('internetdisconnected');
      return;
    }
    await route.fallback();
  });
  await page.getByLabel(ru('item.comment')).fill('Retry me');
  await page.getByTestId('comment-send').click();
  const failure = page.getByTestId('tracker-failure');
  await expect(failure).toContainText(ru('item.err.network.title'));
  await expect(failure.getByRole('button', { name: ru('item.err.retry') })).toBeFocused();
  await failure.getByRole('button', { name: ru('item.err.retry') }).click();
  await expect(page.getByTestId('task-history')).toContainText('Retry me');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);

  await page.route(`**/api/v1/projects/${SLUG}/items/${String(number)}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://team-console/problems/owner-only',
        title: 'Owner only',
        status: 403,
      }),
    });
  });
  await page.getByRole('button', { name: `${ru('item.kind')}: ${ru('board.kind.bug')}` }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${ru('board.kind.chore')}`) }).click();
  await expect(page.getByTestId('tracker-failure')).toContainText(ru('item.err.forbidden.title'));
  await expect(page.getByTestId('tracker-retry')).toHaveCount(0);
});

test('an unknown number says there is no such task', async ({ page }) => {
  await page.goto(`/p/${SLUG}/t/999`);
  await expect(page.getByTestId('task-not-found')).toContainText('Задачи #999 нет в team-console');
  await expectAccessible(page, 'task not found');
});
