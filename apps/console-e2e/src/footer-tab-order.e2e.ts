import type { Locator, Page } from '@playwright/test';
import { addDays, calendarDayOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * Dialog footers read in one order (#282, WCAG 2.4.3 Focus Order, 1.3.2 Meaningful Sequence): at 390×844 the actions
 * stack with the main one on top, at 1440×900 they sit in a row with Cancel on the left and the main one on the right
 * — and on both, Tab walks them top to bottom / left to right, because the frame renders them in that order instead
 * of drawing them reversed. Confirmations still focus Cancel first. Three dialogs stand for every one on the shell:
 * «Попросить PM» (a form), the archive confirmation (an alertdialog with a typed check) and batch approve.
 */

const REPO = 'geeera/team-console';
const ISSUE = 36;
const TODAY = calendarDayOf(Date.now());

interface FooterButton {
  readonly name: string;
  readonly top: number;
  readonly left: number;
}

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 520;
const dialog = (page: Page) => page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
const footerButtons = (frame: Locator) => frame.locator('.tc-sheet__foot').getByRole('button');

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

/** The footer's buttons in DOM order, each with where it is drawn once the sheet has settled. */
async function footerLayout(frame: Locator): Promise<FooterButton[]> {
  await frame.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const buttons = footerButtons(frame);
  const layout: FooterButton[] = [];
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box, 'a footer button is drawn').not.toBeNull();
    layout.push({
      name: (await button.textContent())?.trim() ?? '',
      top: Math.round(box?.y ?? NaN),
      left: Math.round(box?.x ?? NaN),
    });
  }
  return layout;
}

/** Visual order: rows from the top, left to right within a row (a row shares its top edge within a few pixels). */
function visualOrderOf(layout: readonly FooterButton[]): string[] {
  return [...layout]
    .sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left))
    .map((button) => button.name);
}

/**
 * The Tab sequence through the footer, started from its first button, equals the DOM order, which equals the visual
 * order; the layout itself is the one the design draws for the width (a stack with the main action on top, or a row
 * with it on the right).
 */
async function expectReadingOrder(page: Page, frame: Locator, primary: string, secondary: string): Promise<void> {
  const layout = await footerLayout(frame);
  const domOrder = layout.map((button) => button.name);
  expect(domOrder, 'two actions in the footer').toEqual(isPhone(page) ? [primary, secondary] : [secondary, primary]);
  expect(visualOrderOf(layout), 'drawn in DOM order').toEqual(domOrder);

  const [first, second] = layout;
  if (first === undefined || second === undefined) {
    throw new Error(`expected two footer buttons, got ${JSON.stringify(domOrder)}`);
  }
  if (isPhone(page)) {
    expect(first.top, 'stacked: the main action on top').toBeLessThan(second.top);
    expect(first.left, 'stacked: full width').toBe(second.left);
  } else {
    expect(Math.abs(first.top - second.top), 'one row').toBeLessThanOrEqual(4);
    expect(first.left, 'Cancel on the left, the main action on the right').toBeLessThan(second.left);
  }

  const buttons = footerButtons(frame);
  await buttons.first().focus();
  await expect(buttons.first()).toBeFocused();
  for (let index = 1; index < layout.length; index += 1) {
    await page.keyboard.press('Tab');
    await expect(buttons.nth(index), `Tab ${index}: ${domOrder[index]}`).toBeFocused();
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await fakePost(stack, '/_fake/milestones', {
    repo: REPO,
    milestones: [
      { number: 1, title: 'Sprint 01', state: 'closed', dueOn: `${addDays(TODAY, -5)}T12:00:00Z` },
      { number: 2, title: 'Sprint 02', state: 'open', dueOn: `${addDays(TODAY, 9)}T12:00:00Z` },
      { number: 3, title: 'Sprint 03', state: 'open', dueOn: `${addDays(TODAY, 23)}T12:00:00Z` },
    ],
  });
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: ISSUE,
    title: 'Web push client: subscribe button, iOS guide, tap',
    author: 'geeera',
    repoOwner: { login: 'geeera', id: 100001 },
    milestone: 'Sprint 02',
  });
  await seed(stack, [REPO, 'geeera/private-product']);
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

test('«Попросить PM»: Tab walks the footer in the order it is drawn', async ({ page }) => {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('issues-group')).toBeVisible();
  await page.getByTestId('ask-command').click();
  await expect(dialog(page).getByRole('heading', { name: ru('commands.pick.title') })).toBeVisible();
  await dialog(page).getByLabel(ru('commands.pick.find')).fill(String(ISSUE));
  await dialog(page).locator(`tc-list-row[data-number="${ISSUE}"] button`).click();
  const form = dialog(page);
  await expect(form.getByTestId('request-now')).toBeVisible();

  await expectReadingOrder(page, form, ru('commands.request.okNone'), ru('commands.dialog.cancel'));
  await expectAccessible(page, 'Ask the PM form');

  // Cancel is still Cancel after the move.
  await form.getByRole('button', { name: ru('commands.dialog.cancel') }).click();
  await expect(page.getByRole('dialog', { name: new RegExp(`^#${ISSUE} `) })).toHaveCount(0);
});

test('the archive confirmation: Cancel is focused first and the row reads Cancel, then Archive', async ({ page }) => {
  await page.goto('/settings/projects/private-product');
  await expect(page.getByTestId('archive-project')).toBeVisible();
  await page.getByTestId('archive-project').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(ru('settings.archive.title', { name: 'private-product' }));
  await expect(confirm.locator('.tc-confirm__cancel')).toBeFocused();

  await expectReadingOrder(
    page,
    confirm,
    ru('settings.archive.confirm'),
    ru('ui.confirm.cancel'),
  );
  await expectAccessible(page, 'Archive confirmation');

  await confirm.locator('.tc-confirm__cancel').click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('batch approve: the main action and Cancel read in the drawn order', async ({ page }) => {
  await page.goto('/needs-you');
  const open = page.getByTestId('batch-approve');
  await expect(open).toHaveText(ru('commands.batch.approve', { n: 2 }));
  await open.click();
  const batch = page.getByRole('alertdialog', { name: ru('commands.batch.title') });
  await expect(batch).toBeVisible();
  await expect(batch.locator('tc-check-row')).toHaveCount(2);

  await expectReadingOrder(page, batch, ru('commands.batch.ok', { n: 2 }), ru('commands.batch.cancel'));
  await expectAccessible(page, 'Batch approve dialog');

  await batch.getByRole('button', { name: ru('commands.batch.cancel') }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
