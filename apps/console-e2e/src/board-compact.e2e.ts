import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * The compact board (#275) at 390×844 (iphone) and 1440×900 (desktop), on the mock repository (20 sprint issues,
 * 10 of them done; 4 open PRs, #40 failing; 3 runs seeded per test): the key status is on the first screen, no label wraps, the
 * phone's lists are tabs and its lane switcher one row, every list stops at five rows, and the tiles jump to their
 * list.
 */

const BOARD = '/p/team-console/board';
const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 900;
const BOARD_SCOPE = { root: 'main', skip: '' };
const REPO = 'geeera/team-console';
const RUN_LOG = 22;
const MINUTE = 60_000;
/** «Прогоны 3»: the runs every test seeds. */
const RUNS_TAB = ru('board.tabs.runs', { n: 3 });
/** The text stress scroll-regions uses: wider type, as on CI's Linux fonts, must not cut a tile value. */
const WIDE_TYPE = 'html { letter-spacing: 0.08em; }';

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

/**
 * The run log is fake-GitHub state other specs rewrite (board-run-state leaves it empty): reset it to three runs —
 * dev running, qa and pm finished — so nothing here depends on which spec ran before.
 */
async function seedRuns(stack: Stack): Promise<void> {
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: RUN_LOG,
    title: 'Team run log',
    author: 'geeera',
    labels: ['team:run-log'],
    repoOwner: { login: 'geeera', id: 100001 },
  });
  const now = Date.now();
  const entries = [
    { run: 'c-r1', slot: 'slot-pm', state: 'started', minutesAgo: 60 },
    { run: 'c-r1', slot: 'slot-pm', state: 'finished', minutesAgo: 50 },
    { run: 'c-r2', slot: 'slot-qa', state: 'started', minutesAgo: 40 },
    { run: 'c-r2', slot: 'slot-qa', state: 'finished', minutesAgo: 30 },
    { run: 'c-r3', slot: 'slot-dev', state: 'started', minutesAgo: 5 },
  ];
  for (const entry of entries) {
    await fakePost(stack, '/_fake/comment', {
      repo: REPO,
      number: RUN_LOG,
      body: `<!-- pt-run id=${entry.run} slot=${entry.slot} state=${entry.state} -->\n**${entry.slot}** ${entry.state}`,
      author: 'geeera',
      createdAt: now - entry.minutesAgo * MINUTE,
    });
  }
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, [REPO]);
  await seedRuns(stack);
});

async function openBoard(page: Page, path = BOARD): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('stats')).toBeVisible();
  // The «waiting for you» count arrives from the shell's own poll.
  await expect(page.getByTestId('waiting-stat')).toHaveAttribute('data-waiting', /^\d+$/);
  await page.waitForLoadState('networkidle');
}

/** The bottom of the first screen: above the phone's tab bar, the viewport on a wide screen. */
async function foldOf(page: Page): Promise<number> {
  const viewport = page.viewportSize()?.height ?? 0;
  const tabBar = page.locator('nav[tc-tab-bar][bottom]');
  if ((await tabBar.count()) === 0) {
    return viewport;
  }
  return (await tabBar.boundingBox())?.y ?? viewport;
}

async function expectAboveFold(page: Page, target: Locator, what: string): Promise<void> {
  const fold = await foldOf(page);
  const box = await target.boundingBox();
  expect(box, what).not.toBeNull();
  expect(box?.y ?? -1, `${what}: top`).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? 0), `${what}: bottom`).toBeLessThanOrEqual(fold + 0.5);
}

/**
 * Runs in the page: every visible label inside `root` (and outside `skip`, a selector list starting with a comma) that renders on more than one line (its text's line boxes have
 * more than one top), or is cut by its box. Buttons, chips, tabs, tile labels and values, lane cells, headings of lists.
 */
function wrappedLabelsOf({ root, skip }: { root: string; skip: string }): string[] {
  const selectors = [
    'button',
    'a[tc-button]',
    'tc-chip',
    '[role="tab"]',
    '.tc-stat__label',
    '.tc-stat__text',
    '.tc-stat__sub',
    '.tc-lanes__cell-name',
    '.tc-lane__head',
    '.board__section-title',
    '.repos__title',
    '.repo__name',
    '.repo__meta',
  ];
  const found: string[] = [];
  const scope = document.querySelector(root);
  for (const element of Array.from(scope?.querySelectorAll<HTMLElement>(selectors.join(',')) ?? [])) {
    if (
      element.closest(`.tc-sr-only, [hidden], [aria-hidden="true"]${skip}`) !== null ||
      element.offsetParent === null
    ) {
      continue;
    }
    // A lane cell stacks its name over its count on purpose; its name is checked on its own.
    if (element.matches('.tc-lanes__cell')) {
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = new Set(
      Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top + rect.height / 2)),
    );
    // Line boxes of one line share a middle within a few pixels (an icon beside the text sits a little higher).
    const middles = [...tops].sort((a, b) => a - b);
    const lines = middles.filter(
      (middle, index) => index === 0 || middle - (middles[index - 1] ?? 0) > 6,
    ).length;
    const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (lines > 1) {
      found.push(
        `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''} «${text}» on ${lines} lines`,
      );
    }
  }
  return found;
}

/** Runs in the page: tile values cut by an ellipsis (the spec allows it as a last resort; the fixture must fit). */
function cutTileValuesOf(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="stats"] .tc-stat__text'))
    .filter((element) => element.scrollWidth > element.clientWidth + 1)
    .map((element) => element.textContent?.trim() ?? '');
}

/** No tile value ends in an ellipsis, also with wider type (the fit must not rest on one machine's font). */
async function expectNoCutTileValue(page: Page): Promise<void> {
  expect(await page.evaluate(cutTileValuesOf), 'no tile value cut').toEqual([]);
  await page.addStyleTag({ content: WIDE_TYPE });
  expect(await page.evaluate(cutTileValuesOf), 'no tile value cut with wider type').toEqual([]);
  await page.evaluate(() => document.head.lastElementChild?.remove());
}

test('the key status is on the first screen: sprint, demo date and the four tiles', async ({ page }) => {
  await openBoard(page);

  await expectAboveFold(page, page.getByTestId('demo'), 'the demo chip');
  for (const tile of ['done-stat', 'ci-stat', 'team-stat', 'waiting-stat']) {
    await expectAboveFold(page, page.getByTestId(tile), tile);
  }
  // The title and the demo date share one line.
  const title = await page.getByRole('heading', { level: 2, name: 'Sprint 01' }).boundingBox();
  const demo = await page.getByTestId('demo').boundingBox();
  expect(
    Math.abs((title?.y ?? 0) + (title?.height ?? 0) / 2 - ((demo?.y ?? 0) + (demo?.height ?? 0) / 2)),
  ).toBeLessThan(8);

  if (isPhone(page)) {
    // 2×2: Done and CI side by side, Runs and «waiting» under them; the tabs right after.
    const boxes = await Promise.all(
      ['done-stat', 'ci-stat', 'team-stat', 'waiting-stat'].map((id) => page.getByTestId(id).boundingBox()),
    );
    expect(boxes[0]?.y).toBe(boxes[1]?.y);
    expect(boxes[2]?.y).toBe(boxes[3]?.y);
    expect(boxes[2]?.y ?? 0).toBeGreaterThan(boxes[0]?.y ?? 0);
    await expect(page.getByTestId('open-stat')).toHaveCount(0);
    await expect(page.getByTestId('done-stat')).toContainText(ru('board.stat.doneSub', { n: 10 }));
    await expectAboveFold(page, page.getByRole('tablist', { name: ru('board.tabs.label') }), 'the tabs');
  } else {
    // Five tiles in one row, then PRs and runs beside the issues, both headings on the first screen.
    const tops = await page
      .getByTestId('stats')
      .locator('div[tc-stat]')
      .evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)));
    expect(tops).toHaveLength(5);
    expect(new Set(tops).size).toBe(1);
    await expectAboveFold(
      page,
      page.getByTestId('pulls').getByRole('heading', { level: 2 }),
      'the PR heading',
    );
    await expectAboveFold(
      page,
      page.getByTestId('runs').getByRole('heading', { level: 2 }),
      'the runs heading',
    );
    await expect(page.getByRole('tablist')).toHaveCount(0);
  }
  await expectNoCutTileValue(page);
  await expectAccessible(page, 'Compact board');
});

for (const lang of ['ru', 'en'] as const) {
  test(`no button, chip, tab or tile label wraps (${lang})`, async ({ page }) => {
    if (lang === 'en') {
      await page.goto('/settings');
      await page.getByTestId('switch-lang').click();
    }
    await openBoard(page);
    expect(await page.evaluate(wrappedLabelsOf, BOARD_SCOPE), 'the board').toEqual([]);
    if (isPhone(page)) {
      for (const tab of ['board.tabs.pulls', 'board.tabs.runs']) {
        const copy = lang === 'ru' ? ru : en;
        await page
          .getByRole('tab', { name: new RegExp(`^${copy(tab, { n: 0 }).replace(/\s*0$/, '')}`) })
          .click();
        expect(await page.evaluate(wrappedLabelsOf, BOARD_SCOPE), tab).toEqual([]);
      }
    }
    // All projects: «Доступны на GitHub» beside or above «Обновить», and the repository rows (#275 §7.9).
    await page.goto('/overview');
    await expect(
      page.getByTestId('github-repositories').locator('[data-repo="geeera/private-product"]'),
    ).toBeVisible();
    const repos = page.getByTestId('github-repositories');
    // The #278 callout's long button wraps on purpose (#281); everything else in the block keeps one line.
    const wrapped = await page.evaluate(wrappedLabelsOf, {
      root: '[data-testid="github-repositories"]',
      skip: ', .repos__missing, .byname',
    });
    expect(wrapped, 'the repository block').toEqual([]);
    // The Add button is the standard control height, centred on its row.
    const row = repos.locator('[data-repo="geeera/private-product"]');
    const add = row.getByTestId('repo-add');
    const [rowBox, addBox] = [await row.boundingBox(), await add.boundingBox()];
    expect(addBox?.height ?? 0).toBeLessThanOrEqual(isPhone(page) ? 44.5 : 34.5);
    const rowMiddle = (rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2;
    expect(Math.abs((addBox?.y ?? 0) + (addBox?.height ?? 0) / 2 - rowMiddle)).toBeLessThan(2);
  });
}

test('the phone: lists are tabs, the lane switcher is one row and opens on the blockers', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'the tabs and the lane switcher are the narrow layout');
  await openBoard(page);

  const tabs = page.getByRole('tablist', { name: ru('board.tabs.label') }).getByRole('tab');
  await expect(tabs).toHaveText([
    ru('board.tabs.tasks', { n: 20 }),
    ru('board.tabs.pulls', { n: 4 }),
    RUNS_TAB,
  ]);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  const switcher = page.getByRole('group', { name: ru('board.lanes') });
  const cells = switcher.getByRole('button');
  await expect(cells).toHaveCount(5);
  const tops = await cells.evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().top),
  );
  expect(new Set(tops).size, 'one row at 390 px').toBe(1);
  for (const height of await cells.evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  )) {
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    switcher.getByRole('button', { name: new RegExp(`^${ru('board.status.blocked')}\\s*,\\s*3$`) }),
  ).toHaveAttribute('aria-pressed', 'true');
  // An empty lane is dimmed but still a button.
  await expect(
    switcher.getByRole('button', { name: new RegExp(`^${ru('board.status.qa')}\\s*,\\s*0$`) }),
  ).toBeEnabled();

  // Arrow keys move between the board's tabs and select them (APG, automatic activation).
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pulls')).toBeVisible();
  await expect(page.getByTestId('pulls').locator('tc-list-row').first()).toHaveAttribute('data-number', '40');
});

test('a list shows five rows, then «Показать ещё N»', async ({ page }) => {
  await openBoard(page);
  const done = page.locator('tc-lane[data-status="done"]');
  if (isPhone(page)) {
    await page
      .getByRole('group', { name: ru('board.lanes') })
      .getByRole('button', { name: new RegExp(`^${ru('board.status.done')}\\s*,\\s*10$`) })
      .click();
  } else {
    // Done is folded to its heading on a wide screen.
    await expect(done.locator('tc-list-row')).toHaveCount(0);
    await done.getByTestId('done-toggle').click();
    await expect(done.getByTestId('done-toggle')).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(done.locator('tc-list-row')).toHaveCount(5);
  const more = done.getByTestId('show-more');
  await expect(more).toHaveText(ru('board.more', { n: 5 }));
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(done.locator('tc-list-row')).toHaveCount(10);
  await expect(more).toHaveText(ru('board.less'));
  await expect(more).toBeFocused();
  await expectAccessible(page, 'Done lane expanded');
});

test('the CI tile shows the PR list, failing first, and moves focus to it', async ({ page }) => {
  await openBoard(page);
  const ci = page.getByTestId('ci-stat').getByRole('button', {
    name: ru('board.tile.openAria', {
      label: ru('board.stat.ci'),
      value: ru('board.ci.summary.failure.one', { n: 1 }),
      target: ru('board.tile.target.pulls'),
    }),
  });
  await ci.click();
  const pulls = page.getByTestId('pulls');
  await expect(pulls).toBeVisible();
  if (isPhone(page)) {
    await expect(pulls).toBeFocused();
    await expect(page.getByRole('tab', { name: ru('board.tabs.pulls', { n: 4 }) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } else {
    await expect(pulls.getByRole('heading', { level: 2 })).toBeFocused();
  }
  await expect(pulls.locator('tc-list-row').first()).toHaveAttribute('data-number', '40');
  await expect(pulls).toBeInViewport();
});

test('the runs tile shows the runs and moves focus to them; «Ждут вас» opens the questions', async ({
  page,
}) => {
  await openBoard(page);
  await page.getByTestId('team-stat').getByRole('button').click();
  const runs = page.getByTestId('runs');
  await expect(runs.getByTestId('run')).toHaveCount(3);
  await expect(runs.getByTestId('run').first()).toBeInViewport();
  if (isPhone(page)) {
    await expect(runs).toBeFocused();
    await expect(page.getByRole('tab', { name: RUNS_TAB })).toHaveAttribute('aria-selected', 'true');
  } else {
    await expect(runs.getByRole('heading', { level: 2 })).toBeFocused();
  }

  await page.getByTestId('waiting-stat').getByRole('button').click();
  await expect(page).toHaveURL(/\/p\/team-console\/questions$/);
});

test('a deep link opens the runs tab, and the phone opens on the last tab next time', async ({ page }) => {
  test.skip(!isPhone(page), 'tabs are the narrow layout');
  await openBoard(page, `${BOARD}?tab=runs`);
  await expect(page.getByRole('tab', { name: RUNS_TAB })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: ru('board.tabs.pulls', { n: 4 }) }).click();

  await openBoard(page);
  await expect(page.getByRole('tab', { name: ru('board.tabs.pulls', { n: 4 }) })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

/**
 * #294: the board between the phone and a full Mac — a 1024 px screen, and a Mac with the Commands pane open. The
 * layout follows the board's own width: issues and PRs stay two columns with «Открытые PR» on the first screen, the
 * tiles fill whole rows (never one alone), and no tile value is cut.
 */
const MID_WIDTHS = [
  { name: '1024×768', viewport: { width: 1024, height: 768 }, pane: false },
  { name: '1280×800 with the Commands pane', viewport: { width: 1280, height: 800 }, pane: true },
  { name: '1440×900 with the Commands pane', viewport: { width: 1440, height: 900 }, pane: true },
] as const;

for (const { name, viewport, pane } of MID_WIDTHS) {
  test(`${name}: two columns, PRs on the first screen, no tile alone on its row`, async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'a Mac-width layout');
    await page.setViewportSize(viewport);
    await openBoard(page);
    if (pane) {
      await page.getByTestId('commands-open').click();
      await expect(page.locator('tc-commands-pane')).toBeVisible();
      await page.waitForLoadState('networkidle');
    }

    const tasks = await page.locator('.board__tasks').boundingBox();
    const pulls = page.getByTestId('pulls');
    const pullsBox = await pulls.boundingBox();
    expect(pullsBox?.x ?? 0, 'PRs beside the issues').toBeGreaterThan(
      (tasks?.x ?? 0) + (tasks?.width ?? 0) - 1,
    );
    await expectAboveFold(page, pulls.getByRole('heading', { level: 2 }), 'the PR heading');

    const tops = await page
      .getByTestId('stats')
      .locator('div[tc-stat]')
      .evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)));
    const perRow = [...new Set(tops)].map((top) => tops.filter((each) => each === top).length);
    expect(
      perRow.every((count) => count === perRow[0]),
      `tiles per row ${perRow.join(' + ')}`,
    ).toBe(true);
    for (const tile of ['done-stat', 'ci-stat', 'team-stat', 'waiting-stat']) {
      await expectAboveFold(page, page.getByTestId(tile), tile);
    }
    await expectNoCutTileValue(page);
    expect(await page.evaluate(wrappedLabelsOf, BOARD_SCOPE), 'no wrapped label').toEqual([]);
    await expectAccessible(page, `Board at ${name}`);
  });
}
