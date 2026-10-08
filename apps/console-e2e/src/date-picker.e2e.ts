import type { Locator, Page } from '@playwright/test';
import { addDays, calendarDayOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { strayScrollsOf } from './support/scroll-regions';
import { seed, type Stack } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * The kit DatePicker in «Перенести демо» (#307), at 390×844 with touch (iphone) and 1440×900 (desktop): the date is
 * picked in the kit's calendar — a popover over the dialog on the Mac, a bottom sheet over the sheet on the iPhone —
 * with the past off, and the move writes `due_on`; the same flow works from the keyboard alone (APG date-picker keys,
 * Escape changes nothing and keeps the dialog, focus returns to the calendar button); the calendar passes axe, has
 * 44 px targets on the phone, and adds no sideways overflow or scroller of its own. No native date input is left.
 */

const REPO = 'geeera/team-console';
const TODAY = calendarDayOf(Date.now());
const DUE = addDays(TODAY, 9);

/** The field's typed form, as the owner reads it. */
const shown = (day: string): string => day.split('-').reverse().join('.');

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

async function milestoneWrites(
  stack: Stack,
): Promise<{ method: string; number: number | null; body: string }[]> {
  const response = await fetch(`${stack.fakeURL ?? ''}/_fake/state`);
  return (
    (await response.json()) as { milestoneWrites: { method: string; number: number | null; body: string }[] }
  ).milestoneWrites;
}

const isPhone = (): boolean => test.info().project.name !== 'desktop';
const moveDialog = (page: Page) => page.getByRole('alertdialog');
const dateField = (page: Page) => moveDialog(page).getByLabel(ru('commands.demo.field'));
const calendarButton = (page: Page, day: string) =>
  moveDialog(page).getByRole('button', { name: ru('ui.datePicker.openWith', { date: shown(day) }) });
/** The calendar: the popover, or the sheet named by the field on the phone. */
const calendar = (page: Page) =>
  isPhone()
    ? page.getByRole('dialog', { name: ru('commands.demo.field') })
    : page.locator('tc-date-picker-panel[role="dialog"]');
const day = (page: Page, value: string) => calendar(page).locator(`[data-day="${value}"]`);

async function openMoveDemo(page: Page): Promise<void> {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('status-sprint')).toContainText('Sprint 02');
  await page.getByTestId('sprint-demo').click();
  await expect(moveDialog(page)).toBeVisible();
  await expect(dateField(page)).toHaveValue(shown(DUE));
}

async function settled(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    const root = element.closest('.cdk-overlay-pane') ?? element;
    await Promise.all(root.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
}

/** Tap on the touch projects, click on the desktop. */
async function press(locator: Locator): Promise<void> {
  await (isPhone() ? locator.tap() : locator.click());
}

/** Sideways overflow anywhere on screen: the document, or an element past the right edge. */
async function sidewaysOverflowOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) {
      found.push(`document ${root.scrollWidth}px in ${root.clientWidth}px`);
    }
    for (const element of Array.from(document.querySelectorAll('.cdk-overlay-container *'))) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && (box.right > root.clientWidth + 1 || box.left < -1)) {
        found.push(
          `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''} ${Math.round(box.left)}–${Math.round(box.right)}px`,
        );
      }
    }
    return found.slice(0, 5);
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: 22,
    title: 'Team run log',
    author: 'geeera',
    labels: ['team:run-log'],
    repoOwner: { login: 'geeera', id: 100001 },
  });
});

test.beforeEach(async ({ stack }) => {
  await fakePost(stack, '/_fake/milestones', {
    repo: REPO,
    milestones: [
      { number: 1, title: 'Sprint 01', state: 'closed', dueOn: `${addDays(TODAY, -5)}T12:00:00Z` },
      { number: 2, title: 'Sprint 02', state: 'open', dueOn: `${DUE}T12:00:00Z` },
    ],
  });
  await seed(stack, [REPO]);
});

test.afterAll(async ({ stack }) => {
  if (stack.fakeURL !== null) {
    await fakePost(stack, '/_fake/milestones', {
      repo: REPO,
      milestones: [
        { number: 1, title: 'Sprint 01', state: 'open', dueOn: '2026-10-16T00:00:00Z' },
        { number: 2, title: 'Sprint 02', state: 'open', dueOn: '2026-10-30T00:00:00Z' },
      ],
    });
  }
});

test('«Перенести демо» has no native date input: a typed field and the kit calendar', async ({ page }) => {
  await openMoveDemo(page);
  await expect(
    page.locator('input[type="date"], input[type="datetime-local"], input[type="time"]'),
  ).toHaveCount(0);
  await expect(dateField(page)).toHaveAttribute('type', 'text');
  await expect(dateField(page)).toHaveAttribute('inputmode', 'numeric');
  await expect(calendarButton(page, DUE)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(calendarButton(page, DUE)).toHaveAttribute('aria-expanded', 'false');
});

test('pick a date in the calendar and move the demo', async ({ page, stack }) => {
  const before = (await milestoneWrites(stack)).length;
  await openMoveDemo(page);
  await press(calendarButton(page, DUE));
  await expect(calendar(page)).toBeVisible();
  await settled(calendar(page));

  // Opens on the demo's day; today is marked; the past cannot be picked.
  await expect(day(page, DUE)).toHaveAttribute('aria-selected', 'true');
  await expect(day(page, DUE)).toBeFocused();
  const yesterday = day(page, addDays(TODAY, -1));
  if ((await yesterday.count()) > 0) {
    await expect(yesterday).toHaveAttribute('aria-disabled', 'true');
  }
  if ((await day(page, TODAY).count()) > 0) {
    await expect(day(page, TODAY)).toHaveAttribute('aria-current', 'date');
  }
  if (isPhone()) {
    // A sheet over the «Перенести демо» sheet, its actions in the footer with «Готово» first.
    const foot = calendar(page).locator('.tc-sheet__foot button');
    await expect(foot).toHaveText([ru('ui.datePicker.done'), ru('ui.datePicker.today')]);
    for (const target of [
      day(page, DUE),
      calendar(page).getByRole('button', { name: ru('ui.datePicker.next') }),
      calendar(page).getByRole('button', { name: ru('ui.close') }),
      foot.first(),
      foot.last(),
    ]) {
      const box = await target.boundingBox();
      expect(meetsMinTap(box?.height), `${await target.textContent()} height`).toBe(true);
      expect(meetsMinTap(box?.width), `${await target.textContent()} width`).toBe(true);
    }
  } else {
    // The popover hangs under the field, inside the dialog's width, above it in the overlay.
    const field = await dateField(page).boundingBox();
    const popover = await calendar(page).boundingBox();
    expect(popover !== null && field !== null && popover.y >= field.y + field.height).toBe(true);
  }
  expect(await strayScrollsOf(page), 'no scroller besides the document').toEqual([]);
  expect(await sidewaysOverflowOf(page), 'nothing wider than the screen').toEqual([]);
  await expectAccessible(page, 'The demo date calendar');

  // Pick: a day selects, «Готово» commits.
  const moved = addDays(DUE, 2);
  if ((await day(page, moved).count()) === 0) {
    await press(calendar(page).getByRole('button', { name: ru('ui.datePicker.next') }));
  }
  await press(day(page, moved));
  await expect(day(page, moved)).toHaveAttribute('aria-selected', 'true');
  await expect(dateField(page)).toHaveValue(shown(DUE));
  await press(calendar(page).getByRole('button', { name: ru('ui.datePicker.done') }));
  await expect(calendar(page)).toHaveCount(0);
  await expect(dateField(page)).toHaveValue(shown(moved));
  await expect(calendarButton(page, moved)).toBeFocused();

  const ok = moveDialog(page).locator('.tc-confirm__ok');
  await expect(ok).not.toHaveText(ru('commands.demo.same'));
  await press(ok);
  await expect(moveDialog(page)).toHaveCount(0);
  expect((await milestoneWrites(stack)).slice(before)).toEqual([
    expect.objectContaining({ method: 'PATCH', number: 2, body: `{"due_on":"${moved}T12:00:00Z"}` }),
  ]);
});

test('keyboard only: open, move with the APG keys, Escape changes nothing, Enter commits, Enter sends', async ({
  page,
  stack,
}) => {
  const before = (await milestoneWrites(stack)).length;
  await openMoveDemo(page);
  // From the dialog's first focus (Cancel) to the calendar button by Tab alone.
  const button = calendarButton(page, DUE);
  for (
    let step = 0;
    step < 8 && !(await button.evaluate((element) => element === document.activeElement));
    step++
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(calendar(page)).toBeVisible();
  await expect(day(page, DUE)).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'true');

  // ← → ↑ ↓, Home/End, PageDown/PageUp: focus moves, the selection stays.
  await page.keyboard.press('ArrowRight');
  await expect(day(page, addDays(DUE, 1))).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(day(page, addDays(DUE, 8))).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await expect(day(page, DUE)).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect(calendar(page).locator('[data-day][tabindex="0"]')).toHaveAttribute(
    'data-day',
    /^\d{4}-\d{2}-\d{2}$/,
  );
  await page.keyboard.press('PageUp');
  await expect(day(page, DUE)).toBeFocused();
  await page.keyboard.press('End');
  await expect(calendar(page).locator('[data-day][tabindex="0"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(calendar(page).locator('[data-day][tabindex="0"]')).toBeFocused();
  await expectAccessible(page, 'The demo date calendar, keyboard focus in the grid');

  // Escape: the calendar closes, the value and the «Перенести демо» dialog stay, focus is back on the button.
  await page.keyboard.press('Escape');
  await expect(calendar(page)).toHaveCount(0);
  await expect(moveDialog(page)).toBeVisible();
  await expect(dateField(page)).toHaveValue(shown(DUE));
  await expect(button).toBeFocused();

  // Enter on a day commits and closes.
  await page.keyboard.press('Enter');
  await expect(day(page, DUE)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const moved = addDays(DUE, 2);
  await expect(day(page, moved)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(calendar(page)).toHaveCount(0);
  await expect(dateField(page)).toHaveValue(shown(moved));
  await expect(calendarButton(page, moved)).toBeFocused();

  // Back to the field with Shift+Tab; Enter there sends, as in any field of a confirmation.
  await page.keyboard.press('Shift+Tab');
  await expect(dateField(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(moveDialog(page)).toHaveCount(0);
  expect((await milestoneWrites(stack)).slice(before)).toEqual([
    expect.objectContaining({ method: 'PATCH', number: 2, body: `{"due_on":"${moved}T12:00:00Z"}` }),
  ]);
});

test('typed text: a date that does not exist is refused in words, a past one by the demo rule', async ({
  page,
}) => {
  await openMoveDemo(page);
  const ok = moveDialog(page).locator('.tc-confirm__ok');
  await dateField(page).fill('31.02.2026');
  await dateField(page).blur();
  await expect(dateField(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(moveDialog(page)).toContainText('Такой даты нет. Введите её как ДД.ММ.ГГГГ');
  await expect(dateField(page)).toHaveValue('31.02.2026');
  await expect(ok).toHaveAttribute('aria-disabled', 'true');

  await dateField(page).fill(shown(addDays(TODAY, -1)));
  await dateField(page).blur();
  await expect(moveDialog(page)).toContainText(ru('commands.demo.past'));

  await dateField(page).fill(shown(addDays(TODAY, 11)));
  await dateField(page).blur();
  await expect(dateField(page)).not.toHaveAttribute('aria-invalid', 'true');
  await expect(ok).not.toHaveAttribute('aria-disabled', 'true');
  await expectAccessible(page, 'Move the demo with a typed date');
  await moveDialog(page).locator('.tc-confirm__cancel').click();
});
