import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, patchItem, switchToConsoleTracker } from './support/tracker-seed';

/**
 * ⋯ Move on a board row (#558, #409 §2.2 and §8): Sprint 01 is current, Sprint 02 next. Each test plans a fresh
 * in-progress task into Sprint 01 (the lane the phone opens on) and moves it out afterwards. A move applies at once,
 * Undo puts it back; a refused move is an alert at the top of the section and the row stays.
 */

const SLUG = 'team-console';
const TITLE = 'Board move';
let number = 0;

test.describe.configure({ mode: 'serial' });

function inDays(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(Date.now() + days * 86_400_000));
}

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    await createSprint(api, SLUG, inDays(10));
    await createSprint(api, SLUG, inDays(24));
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ stack }) => {
  const api = await apiClient(stack);
  try {
    number = await createItem(api, SLUG, { title: TITLE, status: 'in-progress', sprint: 1 });
  } finally {
    await api.dispose();
  }
});

// The current lane shows five rows before «Show more»: each test's task leaves Sprint 01 once it is done.
test.afterEach(async ({ stack }) => {
  const api = await apiClient(stack);
  try {
    await patchItem(api, SLUG, number, { sprint: null });
  } finally {
    await api.dispose();
  }
});

const key = (): string => `TC-${String(number)}`;
const current = (page: Page): Locator => page.locator('tc-sprint-board');
const nextFolder = (page: Page): Locator => page.locator('tc-board-folder[data-folder="next"]');
const backlogFolder = (page: Page): Locator => page.locator('tc-board-folder[data-folder="backlog"]');
const row = (section: Locator): Locator => section.locator(`tc-list-row[data-number="${String(number)}"]`);
const moveButton = (section: Locator, copy = ru): Locator =>
  section.getByRole('button', { name: copy('plan.moveAria', { key: key(), title: TITLE }), exact: true });
/** «3 открытые»: the count is the leading number. */
const counted = (n: number): RegExp => new RegExp(`^${String(n)}\\D`);
const countOf = async (locator: Locator): Promise<number> => Number.parseInt(await locator.innerText(), 10);

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/p/${SLUG}/board`);
  await expect(row(current(page))).toBeVisible();
}

async function patchAnswers(page: Page, status: number, type: string): Promise<void> {
  await page.route(`**/api/v1/projects/${SLUG}/items/${String(number)}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: `https://team-console/problems/${type}`, title: type, status }),
    });
  });
}

test('moves a row to the next sprint at once and Undo puts it back, focus following', async ({ page }) => {
  await openBoard(page);
  await nextFolder(page).getByRole('button', { name: 'Показать задачи: Sprint 02' }).click();
  await expect(nextFolder(page).locator('[data-state="loaded"]')).toBeAttached();
  const currentCount = await countOf(page.getByTestId('open-count'));
  const nextCount = await countOf(nextFolder(page).getByTestId('folder-open-count'));

  const button = moveButton(current(page));
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const menu = page.getByRole('menu', { name: ru('plan.menuAria', { key: key() }) });
  await expect(page.getByText(ru('plan.inProgressWarn'))).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /В Sprint 01 — текущий/ })).toHaveAttribute('aria-disabled', 'true');
  await expectAccessible(page, 'board move menu open');
  await menu.getByRole('menuitem', { name: /В Sprint 02/ }).click();

  await expect(page.getByTestId('undo-toast')).toContainText(`${key()} → Sprint 02`);
  await expect(row(current(page))).toHaveCount(0);
  await expect(row(nextFolder(page))).toBeVisible();
  await expect(page.getByTestId('open-count')).toHaveText(counted(currentCount - 1));
  await expect(nextFolder(page).getByTestId('folder-open-count')).toHaveText(counted(nextCount + 1));
  // The row that took its place, or the lane heading when it was the last one.
  await expect(current(page).locator(':focus')).toHaveCount(1);

  await page.getByTestId('undo-toast').getByRole('button', { name: ru('plan.undo') }).click();
  await expect(row(nextFolder(page))).toHaveCount(0);
  await expect(moveButton(current(page))).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: `Возвращено: ${key()} снова в Sprint 01` })).toBeVisible();
  await expect(nextFolder(page).getByTestId('folder-open-count')).toHaveText(counted(nextCount));
});

test('moves a row to the backlog, its count follows unopened, and ⌘Z / Ctrl+Z undoes it', async ({ page }) => {
  await openBoard(page);
  const backlogCount = await countOf(backlogFolder(page).getByTestId('folder-open-count'));
  await moveButton(current(page)).click();
  await page.getByRole('menuitem', { name: new RegExp(ru('plan.toBacklog')) }).click();
  await expect(row(current(page))).toHaveCount(0);
  await expect(backlogFolder(page).getByTestId('folder-open-count')).toHaveText(counted(backlogCount + 1));

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(row(current(page))).toBeVisible();
  await expect(backlogFolder(page).getByTestId('folder-open-count')).toHaveText(counted(backlogCount));
});

test('a move into a frozen sprint is refused: an alert on top, the row stays, nothing says moved', async ({ page }) => {
  await openBoard(page);
  await patchAnswers(page, 409, 'sprint-frozen');
  await moveButton(current(page)).click();
  await page.getByRole('menuitem', { name: /В Sprint 02/ }).click();
  const alert = current(page).getByRole('alert');
  await expect(alert).toContainText(ru('item.err.frozen.title'));
  await expect(row(current(page))).toBeVisible();
  await expect(page.getByTestId('undo-toast')).toHaveCount(0);
  await expectAccessible(page, 'board move refused');
});

test('the service identity gets 403: only the owner may move, no Try again', async ({ page }) => {
  await openBoard(page);
  await patchAnswers(page, 403, 'owner-only');
  await moveButton(current(page)).click();
  await page.getByRole('menuitem', { name: new RegExp(ru('plan.toBacklog')) }).click();
  await expect(current(page).getByRole('alert')).toContainText(ru('item.err.forbidden.title'));
  await expect(current(page).getByTestId('tracker-retry')).toHaveCount(0);
  await expect(row(current(page))).toBeVisible();
});

test('offline after load, every ⋯ is aria-disabled and says so', async ({ page, context }) => {
  await openBoard(page);
  await context.setOffline(true);
  try {
    const button = moveButton(current(page));
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(ru('item.offlineReason'));
    // Still a tab stop: Enter says why instead of opening the menu.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(button).toBeFocused();
  } finally {
    await context.setOffline(false);
  }
});

test.describe('in English', () => {
  test.use({ locale: 'en-US' });

  test('the Move menu open has no serious axe violations', async ({ page }) => {
    await openBoard(page);
    await moveButton(current(page), en).click();
    await expect(page.getByRole('menu', { name: en('plan.menuAria', { key: key() }) })).toBeVisible();
    await expectAccessible(page, 'board move menu open, in English');
  });
});
