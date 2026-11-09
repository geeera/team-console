import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, switchToConsoleTracker } from './support/tracker-seed';

/**
 * Plan in the console tracker (#435, #409 §2.2–2.3): Sprint ▾ on the task screen moves a task at once, the toast
 * offers Undo for 10 s (and ⌘Z / Ctrl+Z), and a sprint is created from the board with its demo date validated.
 */

const SLUG = 'team-console';
let number = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    await createSprint(api, SLUG, '2030-01-15');
    await createSprint(api, SLUG, '2030-01-29');
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ stack }) => {
  const api = await apiClient(stack);
  try {
    number = await createItem(api, SLUG, {
      title: 'Threat model: tracker, role keys, runner',
      status: 'approved',
      sprint: 1,
    });
  } finally {
    await api.dispose();
  }
});

const sprintPicker = (page: Page) => page.getByTestId('pick-sprint');

async function openTask(page: Page): Promise<void> {
  await page.goto(`/p/${SLUG}/t/${String(number)}`);
  await expect(page.getByTestId('task-title')).toBeFocused();
}

test('moves a task to another sprint at once and Undo puts it back', async ({ page }) => {
  await openTask(page);
  await sprintPicker(page).click();
  const menu = page.getByRole('menu', { name: `Переместить TC-${String(number)}` });
  const here = menu.getByRole('menuitem', { name: /В Sprint 01 — текущий/ });
  await expect(here).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByRole('menuitem', { name: /В Sprint 02/ })).toBeFocused();
  await expectAccessible(page, 'move menu open');
  // Off, but focusable: picking it says why instead of moving.
  await here.focus();
  await page.keyboard.press('Enter');
  await expect(menu.getByText(ru('plan.here')).first()).toBeVisible();
  await menu.getByRole('menuitem', { name: /В Sprint 02/ }).click();

  const toast = page.getByTestId('undo-toast');
  await expect(toast).toContainText(`TC-${String(number)} → Sprint 02`);
  await expect(sprintPicker(page)).toHaveAccessibleName(/^Спринт: Sprint 02$/);
  await expect(sprintPicker(page)).toBeFocused();
  await expect(page.getByTestId('task-history')).toContainText('Спринт: Sprint 01 → Sprint 02');

  await toast.getByRole('button', { name: new RegExp(ru('plan.undo')) }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Возвращено: TC-${String(number)} снова в Sprint 01` }),
  ).toBeVisible();
  await expect(sprintPicker(page)).toHaveAccessibleName(/^Спринт: Sprint 01 — текущий/);
  // After Undo (axe takes longer than the toast's 10 s, so the toast itself is checked in the next test).
  await expectAccessible(page, 'after undo');
});

test('⌘Z / Ctrl+Z undoes a move to the backlog while the toast is up', async ({ page }) => {
  await openTask(page);
  await sprintPicker(page).click();
  await page.getByRole('menuitem', { name: new RegExp(ru('plan.toBacklog')) }).click();
  await expect(sprintPicker(page)).toHaveAccessibleName(`Спринт: ${ru('item.noSprint')}`);
  // Hover pauses the 10 s, so the toast stays up through the axe run.
  await page.getByTestId('undo-toast').hover();
  await expectAccessible(page, 'undo toast');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(sprintPicker(page)).toHaveAccessibleName(/^Спринт: Sprint 01 — текущий/);
});

test('creates a sprint from the board after the latest one, refusing a date before its demo', async ({
  page,
}) => {
  await page.goto(`/p/${SLUG}/board`);
  await page.getByTestId('create-sprint').click();
  const dialog = page.getByRole('dialog', { name: ru('sprintNew.title') });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(ru('sprintNew.name'))).toHaveValue('Sprint 03');
  const date = dialog.getByLabel(ru('sprintNew.date'));
  await expect(date).toHaveValue('12.02.2030');
  await expect(dialog).toContainText('Спринт начнётся после демо Sprint 02 (29 января)');
  await date.fill('20.01.2030');
  await date.blur();
  await expect(dialog).toContainText('Демо Sprint 03 должно быть позже демо Sprint 02 (29 января).');
  await expectAccessible(page, 'create sprint invalid');
  await date.fill('12.02.2030');
  await date.blur();
  await dialog.getByRole('button', { name: 'Создать Sprint 03' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Sprint 03 создан' })).toBeVisible();
});
