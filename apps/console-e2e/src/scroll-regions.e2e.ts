import type { Page } from '@playwright/test';
import { addDays, calendarDayOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * One scroll at a time (#274, root cause in the #275 spec), at 390×844 (iphone) and 1440×900 (desktop): every screen
 * scrolls the document and nothing else — not `<main>`, never a scroll inside a scroll — so the iPhone's status-bar
 * tap reaches the top; with a dialog open only that dialog's body scrolls, while the page and any sheet underneath
 * hold still. The «Попросить PM» form fits the screen with its title and actions in view.
 *
 * A scroll region is an element with `overflow: auto|scroll` whose content is larger than its box, or the document
 * when it overflows. Besides the document only a column pinned to the viewport may scroll (sticky or fixed and no
 * taller than the screen: the Commands pane beside a wide page), because it never moves with the page.
 */

const REPO = 'geeera/team-console';
const ISSUE = 36;
const TODAY = calendarDayOf(Date.now());

const STORYBOOK = 'https://team-console-storybook.pages.dev';

/**
 * `isTall`: long enough with the seeded data that the document itself must scroll. `waitFor`: a test id the screen
 * shows once its widest content is in (All projects' missing-repository step, #278, with its long GitHub link).
 */
const SCREENS: readonly { path: string; isTall: boolean; waitFor?: string }[] = [
  { path: '/needs-you', isTall: true },
  { path: '/overview', isTall: false, waitFor: 'repos-missing' },
  { path: '/p/team-console/questions', isTall: true },
  { path: '/p/team-console/demo', isTall: true },
  { path: '/p/team-console/board', isTall: true },
  { path: '/p/team-console/artifacts', isTall: true },
  { path: '/settings', isTall: false },
];

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

/** Everything that scrolls with the page besides the document itself; empty when the document is the one scroll. */
async function strayScrollsOf(page: Page): Promise<string[]> {
  const regions = await page.evaluate(scrollRegionsOf);
  return regions
    .filter((region) => region.name !== 'document' && !region.isPinned)
    .map((region) => (region.inside === null ? region.name : `${region.name} inside ${region.inside}`));
}

/**
 * Sideways overflow (#281 QA): the document must never be wider than the screen, and no element may stick out past
 * its right edge — `overflow-x: clip` on the shell would hide it, not make it readable. Content inside its own
 * horizontal scroller (a code block, the tab bar) and visually hidden text are not page width.
 */
async function sidewaysOverflowOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) {
      found.push(`document ${root.scrollWidth}px in ${root.clientWidth}px`);
    }
    const main = document.querySelector('main');
    const edge = root.clientWidth;
    const ownScroller = (element: Element): boolean => {
      for (let node = element.parentElement; node !== null && node !== main; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== 'visible') {
          return true;
        }
      }
      return false;
    };
    for (const element of Array.from(main?.querySelectorAll('*') ?? [])) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= edge + 1 || element.closest('.tc-sr-only') !== null) {
        continue;
      }
      if (!ownScroller(element)) {
        found.push(
          `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''} right ${Math.round(box.right)}px`,
        );
      }
    }
    return found.slice(0, 5);
  });
}

const documentScrolls = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);

/** Answers the Storybook embed of the demo section locally instead of the internet. */
async function servePreviews(page: Page, allow: (origin: string) => void): Promise<void> {
  allow(STORYBOOK);
  await page.route(`${STORYBOOK}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="en"><head><title>Storybook</title></head><body><main><h1>Storybook preview</h1></main></body></html>',
    }),
  );
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

for (const { path, isTall, waitFor } of SCREENS) {
  test(`${path} scrolls the document only, never a scroll inside a scroll`, async ({
    page,
    outsideRequests,
  }) => {
    await servePreviews(page, (origin) => outsideRequests.allow(origin));
    await page.goto(path);
    await expect(page.locator('main#tc-main')).toBeVisible();
    // Lists arrive after the shell: wait until the page has stopped growing.
    await page.waitForLoadState('networkidle');
    if (waitFor !== undefined) {
      await expect(page.getByTestId(waitFor)).toBeVisible();
    }
    expect(await strayScrollsOf(page)).toEqual([]);
    expect(await sidewaysOverflowOf(page), 'nothing wider than the screen').toEqual([]);
    // The same with wider type: CI's Linux fonts set the #278 link at 372px where macOS sets 342px, so a row that
    // fits by a few pixels on one machine overflows on another. Text must wrap, not rely on the font's width.
    await page.addStyleTag({ content: 'html { letter-spacing: 0.08em; }' });
    expect(await sidewaysOverflowOf(page), 'nothing wider than the screen with wider type').toEqual([]);
    await page.evaluate(() => document.head.lastElementChild?.remove());
    if (isTall) {
      expect(await documentScrolls(page), 'a long screen scrolls the document').toBe(true);
      // What the status-bar tap does on the iPhone: the document goes to the top, and the whole page with it.
      await page.evaluate(() => window.scrollTo({ top: 400 }));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400);
      await page.evaluate(() => window.scrollTo({ top: 0 }));
      await expect(page.locator('main#tc-main')).toBeInViewport();
      expect(
        await page.locator('main#tc-main').evaluate((element) => element.getBoundingClientRect().top),
      ).toBeLessThan(200);
    }
  });
}

test('the Commands pane beside a page is a pinned column, not a scroll inside the page', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the pane sits beside the page on a wide screen only');
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('issues-group')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await strayScrollsOf(page)).toEqual([]);
});

test('«Попросить PM» fits the screen: title and actions in view, only its body scrolls, the page is locked', async ({
  page,
}) => {
  await page.goto('/p/team-console/questions');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.scrollTo({ top: 400 }));
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

  // The page behind holds its place: a wheel over the scrim moves nothing.
  const pageTop = (): Promise<number> =>
    page.evaluate(() => document.querySelector('main')?.getBoundingClientRect().top ?? NaN);
  const before = await pageTop();
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  expect(await pageTop()).toBe(before);
  await expectAccessible(page, 'Ask the PM form, fitted to the screen');

  // Sending from the footer still submits the form: the button names it.
  await form.getByLabel(ru('commands.request.next', { sprint: 'Sprint 03' })).check();
  await expect(form.getByTestId('request-ok')).toHaveText(ru('commands.request.ok'));
  await form.getByRole('button', { name: ru('commands.dialog.cancel') }).click();
  await expect(page.getByRole('dialog', { name: new RegExp(`^#${ISSUE} `) })).toHaveCount(0);

  // Every sheet closed (the phone's Commands sheet too): the page scrolls again.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await documentScrolls(page)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("the phone's Projects sheet with a long list: Add project and Settings stay in view, only its body scrolls", async ({
  page,
}) => {
  test.skip(
    test.info().project.name !== 'iphone',
    "the Projects sheet is the phone's; wide screens have the sidebar",
  );
  // Thirty projects: the registry answer is stretched in the browser, the seeded project is the template.
  await page.route('**/api/v1/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const projects = (await response.json()) as Record<string, unknown>[];
    const [first] = projects;
    const extra = Array.from({ length: 30 }, (_, index) => ({
      ...first,
      slug: `extra-${index + 1}`,
      repo: `geeera/extra-${index + 1}`,
      displayName: `Extra project ${index + 1}`,
    }));
    await route.fulfill({ response, json: [...projects, ...extra] });
  });
  await page.goto('/needs-you');
  await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
  const sheet = dialog(page);
  await expect(sheet.getByText('Extra project 30')).toBeAttached();
  await sheet.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });

  await expectWithinViewport(page, '[role="dialog"]', 'the Projects sheet');
  const addProject = sheet.locator('.tc-sheet__foot').getByRole('button', { name: ru('shell.addProject') });
  const settings = sheet.locator('.tc-sheet__foot').getByRole('button', { name: ru('shell.settings') });
  await expect(addProject).toBeInViewport({ ratio: 1 });
  await expect(settings).toBeInViewport({ ratio: 1 });

  const regions = await page.evaluate(scrollRegionsOf);
  expect(regions.map((region) => region.name)).toEqual(['div.tc-sheet__body']);
  expect(regions.every((region) => region.isInTopDialog)).toBe(true);

  // At the end of the list the actions are still where they were.
  await sheet
    .locator('.tc-sheet__body')
    .evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(sheet.getByText('Extra project 30')).toBeInViewport();
  await expect(addProject).toBeInViewport({ ratio: 1 });
  await expect(settings).toBeInViewport({ ratio: 1 });
  await expectAccessible(page, 'Projects sheet with a long list');
});
