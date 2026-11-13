import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, switchToConsoleTracker } from './support/tracker-seed';

/**
 * Queue order in the Move menu (#456, #409 §2.2): First in the queue / Up / Down reorder a task within its lane of the
 * current sprint. The lane shows the new order at once, focus stays on the task's ⋯, the new place is announced, and
 * the task screen's Queue line agrees with the board. Three in-progress tasks (the lane the phone opens on): A, B, C.
 */

const SLUG = 'team-console';
const TITLES = ['Queue A', 'Queue B', 'Queue C'] as const;
const numbers: number[] = [];

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
    for (const title of TITLES) {
      numbers.push(await createItem(api, SLUG, { title, status: 'in-progress', sprint: 1 }));
    }
  } finally {
    await api.dispose();
  }
});

const key = (index: number): string => `TC-${String(numbers[index])}`;
const lane = (page: Page): Locator => page.locator('tc-sprint-board tc-lane[data-status="in-progress"]');
const moveButton = (page: Page, index: number, copy = ru): Locator =>
  lane(page).getByRole('button', {
    name: copy('plan.moveAria', { key: key(index), title: TITLES[index] ?? '' }),
    exact: true,
  });
const menu = (page: Page, index: number, copy = ru): Locator =>
  page.getByRole('menu', { name: copy('plan.menuAria', { key: key(index) }) });
/** The lane's rows as the owner reads them, top to bottom. */
const laneOrder = (page: Page): Promise<string[]> =>
  lane(page)
    .locator('tc-list-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-number') ?? ''));
const expectOrder = async (page: Page, indexes: readonly number[]): Promise<void> => {
  await expect
    .poll(() => laneOrder(page), { message: 'the lane rows, top to bottom' })
    .toEqual(indexes.map((index) => String(numbers[index])));
};

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/p/${SLUG}/board`);
  await expect(lane(page).locator(`tc-list-row[data-number="${String(numbers[0])}"]`)).toBeVisible();
}

test('First in the queue: the row goes first, focus stays on its ⋯, the place is announced and the task agrees', async ({
  page,
}) => {
  await openBoard(page);
  await expectOrder(page, [0, 1, 2]);

  await moveButton(page, 2).click();
  const open = menu(page, 2);
  await expect(open.getByRole('group', { name: ru('plan.queueGroup', { lane: ru('board.status.in-progress') }) })).toBeVisible();
  await expect(open.getByRole('menuitem', { name: ru('plan.first') })).toBeFocused();
  await expect(open.getByRole('menuitem', { name: ru('plan.up') })).not.toHaveAttribute('aria-disabled', 'true');
  const down = open.getByRole('menuitem', { name: new RegExp(`^${ru('plan.down')}`) });
  await expect(down).toHaveAttribute('aria-disabled', 'true');
  await expect(down).toHaveAccessibleDescription(ru('plan.alreadyLast'));
  await expectAccessible(page, 'queue menu open');

  await open.getByRole('menuitem', { name: ru('plan.first') }).click();
  await expectOrder(page, [2, 0, 1]);
  await expect(moveButton(page, 2)).toBeFocused();
  await expect(page.locator('.cdk-live-announcer-element')).toContainText(
    ru('plan.reordered', { key: key(2), pos: 1, total: 3, lane: ru('board.status.in-progress') }),
  );
  // No sprint changed: nothing to undo.
  await expect(page.getByTestId('undo-toast')).toHaveCount(0);

  await page.goto(`/p/${SLUG}/t/${String(numbers[2])}`);
  await expect(page.getByTestId('task-queue')).toHaveText(
    ru('item.queueVal', { pos: 1, total: 3, lane: ru('board.status.in-progress') }),
  );
});

test('Up and Down swap with the neighbour; an off item keeps focus and says why', async ({ page }) => {
  await openBoard(page);
  await expectOrder(page, [2, 0, 1]);

  await moveButton(page, 0).click();
  await menu(page, 0).getByRole('menuitem', { name: ru('plan.up') }).click();
  await expectOrder(page, [0, 2, 1]);
  await expect(moveButton(page, 0)).toBeFocused();
  await expect(page.getByTestId('task-queue')).toHaveCount(0);

  // Now first: First and Up are off, focusable, and picking one says why instead of moving.
  await moveButton(page, 0).click();
  const open = menu(page, 0);
  const first = open.getByRole('menuitem', { name: new RegExp(`^${ru('plan.first')}`) });
  await expect(first).toHaveAttribute('aria-disabled', 'true');
  await expect(open.getByRole('menuitem', { name: ru('plan.down') })).toBeFocused();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(open).toBeVisible();
  await expect(open.getByText(ru('plan.alreadyFirst')).first()).toBeVisible();
  await expectAccessible(page, 'queue menu with off items');
  await open.getByRole('menuitem', { name: ru('plan.down') }).click();
  await expectOrder(page, [2, 0, 1]);
  await expect(page.locator('.cdk-live-announcer-element')).toContainText(
    ru('plan.reordered', { key: key(0), pos: 2, total: 3, lane: ru('board.status.in-progress') }),
  );
});

test('the task screen’s Sprint ▾ offers the same queue group and its Queue line follows a move', async ({ page }) => {
  await page.goto(`/p/${SLUG}/t/${String(numbers[1])}`);
  const laneName = ru('board.status.in-progress');
  await expect(page.getByTestId('task-queue')).toHaveText(ru('item.queueVal', { pos: 3, total: 3, lane: laneName }));
  await page.getByTestId('pick-sprint').click();
  const open = page.getByRole('menu', { name: ru('plan.menuAria', { key: key(1) }) });
  await expect(open.getByRole('group', { name: ru('plan.queueGroup', { lane: laneName }) })).toBeVisible();
  await open.getByRole('menuitem', { name: ru('plan.first') }).click();
  await expect(page.getByTestId('task-queue')).toHaveText(ru('item.queueVal', { pos: 1, total: 3, lane: laneName }));
  await expect(page.getByTestId('pick-sprint')).toBeFocused();
  await expect(page.getByTestId('task-history')).toContainText(ru('item.ev.reordered'));

  // The board shows the same order.
  await openBoard(page);
  await expectOrder(page, [1, 2, 0]);
});

test.describe('in English', () => {
  test.use({ locale: 'en-US' });

  test('the queue group reads First in the queue / Up / Down and the menu has no serious axe violations', async ({
    page,
  }) => {
    await openBoard(page);
    // After the tests above the lane reads B, C, A: A is last.
    await moveButton(page, 0, en).click();
    const open = menu(page, 0, en);
    await expect(open.getByRole('group', { name: en('plan.queueGroup', { lane: en('board.status.in-progress') }) })).toBeVisible();
    await expect(open.getByRole('menuitem', { name: en('plan.first') })).toBeVisible();
    await expect(open.getByRole('menuitem', { name: en('plan.up') })).toBeVisible();
    await expect(open.getByRole('menuitem', { name: new RegExp(`^${en('plan.down')}`) })).toHaveAccessibleDescription(
      en('plan.alreadyLast'),
    );
    await expectAccessible(page, 'queue menu open, in English');
  });
});
