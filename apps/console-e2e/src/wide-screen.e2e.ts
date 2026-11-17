import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Wide screens (#766) on the desktop project, resized per check: one page cap, the Artifacts card grid from an 880 px
 * body, more decision cards per row, the board in three columns from a 1360 px body, layouts that follow the body
 * (the Commands pane narrows it), focus that stays put when the layout switches, no duplicated sprint buttons beside
 * the pane, and axe at 1920 in both themes. 375 and 768 px are unchanged (proved by screenshot diffs in the PR).
 */

const ARTIFACTS = '/p/team-console/artifacts';
const QUESTIONS = '/p/team-console/questions';
const BOARD = '/p/team-console/board';
const HEIGHT = 1000;
const STORYBOOK = 'https://team-console-storybook.pages.dev';

/** The most of `items` on one row: the columns of a grid (a short group may fill fewer), 1 for a list. */
async function cardsPerRow(items: Locator): Promise<number> {
  return items.evaluateAll((elements) => {
    const perRow = new Map<number, number>();
    for (const element of elements) {
      const top = Math.round(element.getBoundingClientRect().top);
      perRow.set(top, (perRow.get(top) ?? 0) + 1);
    }
    return Math.max(...perRow.values());
  });
}

async function openArtifacts(page: Page, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(ARTIFACTS);
  const cards = page.getByTestId('artifact');
  await expect(cards.first()).toBeVisible();
  return cards;
}

async function openCommands(page: Page): Promise<void> {
  await page.getByTestId('commands-open').click();
  await expect(page.locator('.cp__title')).toBeFocused();
}

test.describe('wide screens (#766)', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console', 'geeera/private-product']);
  });

  test.beforeEach(async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 900, 'wide screens: the desktop project');
  });

  test('Artifacts is a grid of 4, 3, 3 and 2 cards from an 880 px body, and the row list below it', async ({
    page,
  }) => {
    for (const [width, columns] of [
      [1920, 4],
      [1440, 3],
      [1280, 3],
      [1200, 2],
      [1199, 1],
    ] as const) {
      const cards = await openArtifacts(page, width);
      expect(await cardsPerRow(cards), `cards per row at ${width}`).toBe(columns);
    }
    // The row list keeps no group headings on screen.
    await expect(page.getByTestId('artifact-group').first()).toBeHidden();
  });

  test('the Commands pane narrows the body: the list at 1440 and 1591, cards from 1592', async ({ page }) => {
    for (const [width, columns] of [
      [1440, 1],
      [1591, 1],
      [1592, 2],
      [1920, 3],
    ] as const) {
      const cards = await openArtifacts(page, width);
      await openCommands(page);
      expect(await cardsPerRow(cards), `cards per row at ${width} with Commands`).toBe(columns);
    }
  });

  test('group headings show under «Все» only, and the list still counts only the artifacts', async ({
    page,
  }) => {
    const cards = await openArtifacts(page, 1440);
    const groups = page.getByTestId('artifact-group');
    await expect(groups.first()).toBeVisible();
    await expect(groups.first()).toContainText(ru('artifacts.type.decision'));
    const list = page.getByRole('list', { name: ru('artifacts.listLabel') });
    await expect(list.getByRole('listitem')).toHaveCount(await cards.count());

    await page.locator('[data-testid="artifact-type"][data-type="design"]').click();
    await expect(groups).toHaveCount(0);
    // A design card: the wide preview, never the 56 px row thumbnail.
    const design = page.locator('[data-testid="artifact"][data-issue]').first();
    await expect(design.locator('.artifacts__card-thumb')).toBeVisible();
    await expect(design.locator('.artifacts__thumb')).toBeHidden();
    await expect(page.getByText(ru('designs.tile.none')).first()).toBeVisible();
  });

  test('Tab reads the cards row by row, and focus stays on the card when the body turns into a list', async ({
    page,
  }) => {
    const cards = await openArtifacts(page, 1440);
    const links = cards.locator('a, button');
    await links.nth(0).focus();
    for (const next of [1, 2, 3]) {
      await page.keyboard.press('Tab');
      await expect(links.nth(next)).toBeFocused();
    }
    const [first, third, fourth] = await Promise.all(
      [0, 2, 3].map((index) => links.nth(index).boundingBox()),
    );
    expect(third?.y).toBe(first?.y);
    expect(fourth?.y ?? 0).toBeGreaterThan(third?.y ?? 0);

    // A narrower window (or zoom) takes the body under 880 px: CSS alone switches, the focused card is the same.
    await page.setViewportSize({ width: 1100, height: HEIGHT });
    expect(await cardsPerRow(cards)).toBe(1);
    await expect(links.nth(3)).toBeFocused();
    await expect(links.nth(3)).toBeInViewport();
  });

  test('Вопросы and «Ждут вас»: 3 cards per row at 1920, 2 at 1440 and 1280; Commands takes one off', async ({
    page,
  }) => {
    const cards = page.locator('.questions__list > li');
    for (const [path, width, columns] of [
      [QUESTIONS, 1920, 3],
      [QUESTIONS, 1440, 2],
      [QUESTIONS, 1280, 2],
      ['/needs-you', 1920, 3],
      ['/needs-you', 1280, 2],
    ] as const) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(path);
      await expect(cards.first()).toBeVisible();
      expect(await cardsPerRow(cards), `${path} at ${width}`).toBe(columns);
    }
    for (const [width, columns] of [
      [1920, 2],
      [1280, 1],
    ] as const) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(QUESTIONS);
      await expect(cards.first()).toBeVisible();
      await openCommands(page);
      expect(await cardsPerRow(cards), `questions at ${width} with Commands`).toBe(columns);
    }
  });

  test('the body fills the main column up to the page cap and stays centred beyond it', async ({ page }) => {
    for (const width of [1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(QUESTIONS);
      await expect(page.locator('.questions__list > li').first()).toBeVisible();
      const [main, body, title] = await Promise.all(
        ['main', '.space__body', '.space__title'].map((selector) =>
          page.locator(selector).first().boundingBox(),
        ),
      );
      expect(
        (body?.width ?? 0) / (main?.width ?? 1),
        `body share of main at ${width}`,
      ).toBeGreaterThanOrEqual(0.75);
      // The section title lines up with the body's content edge (padding --pad-x 32).
      expect(Math.round(title?.x ?? 0)).toBe(Math.round((body?.x ?? 0) + 32));
    }
  });

  test('the board: three columns at 1920, two at 1440; beside Commands it drops its copies of the pane’s buttons', async ({
    page,
  }) => {
    const columnsOf = async (): Promise<number> => {
      const [tasks, pulls, runs] = await Promise.all(
        ['.board__tasks', '.board__pulls', '.board__runs'].map((selector) =>
          page.locator(selector).boundingBox(),
        ),
      );
      return new Set([tasks?.x, pulls?.x, runs?.x].map((x) => Math.round(x ?? -1))).size;
    };
    await page.setViewportSize({ width: 1920, height: HEIGHT });
    await page.goto(BOARD);
    await expect(page.locator('.board__runs')).toBeVisible();
    expect(await columnsOf()).toBe(3);
    await expect(page.getByTestId('board-move-demo')).toBeVisible();
    await expect(page.getByTestId('board-ask')).toBeVisible();

    await openCommands(page);
    await expect(page.getByTestId('board-move-demo')).toHaveCount(0);
    await expect(page.getByTestId('board-ask')).toHaveCount(0);
    await expect(page.getByTestId('sprint-demo')).toBeVisible();
    await expect(page.getByTestId('ask-command')).toBeAttached();
    expect(await columnsOf()).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-move-demo')).toBeVisible();

    await page.setViewportSize({ width: 1440, height: HEIGHT });
    expect(await columnsOf()).toBe(2);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`axe finds nothing serious on the five pages at 1920 (${colorScheme})`, async ({
      page,
      outsideRequests,
    }) => {
      // The demo card frames the Storybook prototype: answered locally, as in designs-demo.e2e.ts.
      outsideRequests.allow(STORYBOOK);
      await page.route(`${STORYBOOK}/**`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html lang="en"><head><title>Storybook</title></head><body><main><h1>Storybook preview</h1></main></body></html>',
        }),
      );
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1920, height: HEIGHT });
      for (const [path, ready] of [
        [ARTIFACTS, '[data-testid="artifact"]'],
        [`${ARTIFACTS}?type=design`, '[data-testid="artifact"]'],
        [QUESTIONS, '.questions__list > li'],
        ['/p/team-console/demo', 'li[data-number]'],
        [BOARD, '.board__runs'],
        ['/needs-you', '.questions__list > li'],
      ] as const) {
        await page.goto(path);
        await expect(page.locator(ready).first()).toBeVisible();
        await expectAccessible(page, `${path} at 1920 (${colorScheme})`);
      }
    });
  }
});
