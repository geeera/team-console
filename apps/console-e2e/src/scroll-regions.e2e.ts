import type { Page } from '@playwright/test';
import { addDays, calendarDayOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * One scroll at a time (#274), at 390×844 (iphone) and 1440×900 (desktop): no screen of the console scrolls a region
 * inside another one that moves with it, and with a dialog open only that dialog's body scrolls — the page and any
 * sheet underneath hold still. The «Попросить PM» form fits the screen with its title and actions in view.
 *
 * A scroll region is an element with `overflow: auto|scroll` whose content is larger than its box, or the document
 * when it overflows. A region inside another is allowed only when it is pinned to the viewport (sticky or fixed and
 * no taller than the screen) — the Commands pane beside a wide page — because it never moves with the outer scroll.
 */

const REPO = 'geeera/team-console';
const ISSUE = 36;
const TODAY = calendarDayOf(Date.now());

const SCREENS = [
  '/needs-you',
  '/overview',
  '/p/team-console/questions',
  '/p/team-console/board',
  '/p/team-console/artifacts',
  '/settings',
] as const;

interface ScrollRegion {
  /** `tag.first-class`, enough to name it in a failure. */
  readonly name: string;
  /** The nearest region it scrolls inside, or `null`. */
  readonly inside: string | null;
  readonly isPinned: boolean;
  /** Whether it sits inside the topmost open dialog. */
  readonly isInTopDialog: boolean;
}

/** Runs in the page: every scroll region, as above. */
function scrollRegionsOf(): ScrollRegion[] {
  const root = document.documentElement;
  const viewportHeight = root.clientHeight;
  const nameOf = (element: Element): string =>
    element === root ? 'document' : `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''}`;
  const scrolls = (element: HTMLElement): boolean => {
    if (element === root) {
      return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1;
    }
    const style = getComputedStyle(element);
    const canScroll = (overflow: string): boolean => overflow === 'auto' || overflow === 'scroll';
    return (
      (canScroll(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
      (canScroll(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
    );
  };
  const regions = [root, ...Array.from(document.body.querySelectorAll<HTMLElement>('*'))].filter(scrolls);
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
  const topDialog = dialogs.at(-1) ?? null;

  return regions.map((region) => {
    let outer: HTMLElement | null = null;
    let isPinned = false;
    for (let node = region.parentElement; node !== null; node = node.parentElement) {
      if (regions.includes(node)) {
        outer = node;
        break;
      }
    }
    for (let node: HTMLElement | null = region; node !== null && node !== outer; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === 'sticky' || position === 'fixed') {
        isPinned = region.getBoundingClientRect().height <= viewportHeight + 1;
        break;
      }
    }
    return {
      name: nameOf(region),
      inside: outer === null ? null : nameOf(outer),
      isPinned,
      isInTopDialog: topDialog !== null && topDialog.contains(region),
    };
  });
}

async function nestedScrollsOf(page: Page): Promise<string[]> {
  const regions = await page.evaluate(scrollRegionsOf);
  return regions
    .filter((region) => region.inside !== null && !region.isPinned)
    .map((region) => `${region.name} inside ${region.inside ?? ''}`);
}

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

/** Every element of `selector` lies wholly inside the viewport. */
async function expectWithinViewport(page: Page, selector: string, what: string): Promise<void> {
  const viewport = page.viewportSize();
  const box = await page.locator(selector).last().boundingBox();
  expect(box, what).not.toBeNull();
  if (box === null || viewport === null) {
    return;
  }
  expect(box.y, `${what}: top`).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${what}: bottom`).toBeLessThanOrEqual(viewport.height + 0.5);
}

const dialog = (page: Page) => page.getByRole('dialog').last();

async function openRequestForm(page: Page): Promise<void> {
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('issues-group')).toBeVisible();
  await page.getByTestId('ask-command').click();
  await expect(dialog(page).getByRole('heading', { name: ru('commands.pick.title') })).toBeVisible();
  await dialog(page).getByLabel(ru('commands.pick.find')).fill(String(ISSUE));
  await dialog(page).locator(`tc-list-row[data-number="${ISSUE}"] button`).click();
  await expect(dialog(page).getByTestId('request-now')).toBeVisible();
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

for (const path of SCREENS) {
  test(`${path} scrolls in one place, never a scroll inside a scroll`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main#tc-main')).toBeVisible();
    // Lists arrive after the shell: wait until the page has stopped growing.
    await page.waitForLoadState('networkidle');
    expect(await nestedScrollsOf(page)).toEqual([]);
  });
}

test('the Commands pane beside a page is a pinned column, not a scroll inside the page', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the pane sits beside the page on a wide screen only');
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('issues-group')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await nestedScrollsOf(page)).toEqual([]);
});

test('«Попросить PM» fits the screen: title and actions in view, only its body scrolls, the page is locked', async ({
  page,
}) => {
  await page.goto('/p/team-console/questions');
  await page.waitForLoadState('networkidle');
  const main = page.locator('main#tc-main');
  await main.evaluate((element) => element.scrollTo({ top: 400 }));
  await openRequestForm(page);
  const form = dialog(page);
  // The sheet rises from below the screen: measure where it settles.
  await form.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });

  await expectWithinViewport(page, '[role="dialog"]', 'the dialog');
  await expect(form.getByRole('heading', { name: new RegExp(`^#${ISSUE} `) })).toBeInViewport({ ratio: 1 });
  await expect(form.getByTestId('request-ok')).toBeInViewport({ ratio: 1 });
  await expect(form.getByRole('button', { name: ru('commands.dialog.cancel') })).toBeInViewport({ ratio: 1 });
  await expect(form.locator('.tc-sheet__body [data-testid="request-ok"]')).toHaveCount(0);

  const regions = await page.evaluate(scrollRegionsOf);
  expect(
    regions.filter((region) => !region.isInTopDialog).map((region) => region.name),
    'nothing outside the dialog scrolls',
  ).toEqual([]);
  expect(regions.every((region) => region.name === 'div.tc-sheet__body')).toBe(true);

  // The page behind holds its place: locked, and a wheel over the scrim moves nothing.
  const scrolledTo = await main.evaluate((element) => element.scrollTop);
  await expect(main).toHaveCSS('overflow-y', 'hidden');
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 600);
  expect(await main.evaluate((element) => element.scrollTop)).toBe(scrolledTo);
  await expectAccessible(page, 'Ask the PM form, fitted to the screen');

  // Sending from the footer still submits the form: the button names it.
  await form.getByLabel(ru('commands.request.next', { sprint: 'Sprint 03' })).check();
  await expect(form.getByTestId('request-ok')).toHaveText(ru('commands.request.ok'));
  await form.getByRole('button', { name: ru('commands.dialog.cancel') }).click();
  await expect(page.getByRole('dialog', { name: new RegExp(`^#${ISSUE} `) })).toHaveCount(0);

  // Every sheet closed (the phone's Commands sheet too): the page scrolls again.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(main).toHaveCSS('overflow-y', 'auto');
});
