import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createSprint, switchToConsoleTracker } from './support/tracker-seed';

/**
 * New task (#107): the owner files a task from the phone or the Mac — project, title, details, kind, sprint — as one
 * `POST …/items` with the sprint set directly (`proposed`). The draft survives a close and a reload, a retry never
 * creates two, a frozen sprint offers the backlog in one tap, and an identity the tracker refuses never sees the entry.
 */

const SLUG = 'team-console';
const isPhone = (): boolean => test.info().project.name !== 'desktop';

function dayFromToday(days: number): string {
  const day = new Date(Date.now() + days * 86_400_000);
  return day.toISOString().slice(0, 10);
}

interface ItemRow {
  readonly number: number;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly sprint: number | null;
}

async function items(api: APIRequestContext): Promise<ItemRow[]> {
  const response = await api.get(`/api/v1/projects/${SLUG}/items?limit=100`);
  return ((await response.json()) as { items: ItemRow[] }).items;
}

let api: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  api = await apiClient(stack);
  // Sprint 01 is in its freeze (its demo is tomorrow), Sprint 02 is the next one.
  await createSprint(api, SLUG, dayFromToday(1));
  await createSprint(api, SLUG, dayFromToday(15));
});

test.afterAll(async () => {
  await api?.dispose();
});

function entry(page: Page): Locator {
  return page.getByTestId('new-task-open');
}

async function openNewTask(page: Page): Promise<Locator> {
  await expect(entry(page)).toBeVisible();
  if (isPhone()) {
    await entry(page).click();
  } else {
    // T opens it from anywhere but a text field.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('t');
  }
  const sheet = page.getByRole('dialog', { name: new RegExp(ru('quickTask.title')) });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('creates a task in the next sprint as plain text and links to it', async ({ page }) => {
  await page.goto(`/p/${SLUG}/board`);
  const sheet = await openNewTask(page);
  await expect(sheet.getByTestId('quick-task-title')).toBeFocused();
  await expect(sheet).toContainText(ru('quickTask.into', { name: 'team-console' }));
  // The frozen current sprint is off with its reason; Next is the default.
  const current = sheet.locator('label[data-target="current"]');
  await expect(current).toHaveClass(/tc-choice--off/);
  await expect(current).toContainText(ru('quickTask.sprint.freezeChip'));
  await expect(sheet.getByRole('radio', { name: new RegExp(ru('quickTask.sprint.next')) })).toBeChecked();
  await expectAccessible(page, 'new task form');

  await sheet.getByTestId('quick-task-title').fill('Show the last run on the board');
  await sheet.getByTestId('quick-task-body').fill('Seen on the phone.\n/approve\n<b>not bold</b>');
  await expect(sheet.getByTestId('quick-task-command-note')).toBeVisible();
  await sheet.getByRole('radio', { name: ru('board.kind.bug'), exact: true }).check();
  await sheet.getByTestId('quick-task-create').click();

  const done = sheet.getByTestId('quick-task-done');
  await expect(done).toContainText(/Задача TC-\d+ создана/);
  await expect(sheet).toContainText(ru('quickTask.done.sprint', { sprint: 'Sprint 02' }));
  await expectAccessible(page, 'new task created');

  const created = (await items(api)).find((item) => item.title === 'Show the last run on the board');
  expect(created).toMatchObject({ kind: 'bug', status: 'proposed', sprint: 2 });
  const full = await (await api.get(`/api/v1/projects/${SLUG}/items/${String(created?.number)}`)).json();
  expect((full as { body: string }).body).toBe('Seen on the phone.\n/approve\n<b>not bold</b>');

  await sheet.getByTestId('quick-task-open').click();
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/t/${String(created?.number)}$`));
  await expect(page.getByTestId('task-title')).toContainText('Show the last run on the board');
  await expect(entry(page)).toHaveAccessibleName(ru('quickTask.new'));
});

test('keeps the draft through a close and a reload, then a retry after a drop creates one task', async ({
  page,
}) => {
  await page.goto(`/p/${SLUG}/questions`);
  let sheet = await openNewTask(page);
  await sheet.getByTestId('quick-task-title').fill('Survives an eviction');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: ru('quickTask.draft.kept') })).toBeVisible();

  await page.reload();
  sheet = await openNewTask(page);
  await expect(sheet.getByTestId('quick-task-title')).toHaveValue('Survives an eviction');
  await expect(sheet.getByTestId('quick-task-draft')).toBeVisible();

  // The first send reaches the server but its answer is lost; the retry replays it.
  let isFirst = true;
  await page.route(`**/api/v1/projects/${SLUG}/items`, async (route) => {
    if (route.request().method() !== 'POST' || !isFirst) {
      await route.continue();
      return;
    }
    isFirst = false;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await sheet.getByTestId('quick-task-create').click();
  await expect(sheet.getByTestId('quick-task-failure')).toHaveAttribute('data-kind', 'network');
  await expect(sheet.getByTestId('quick-task-title')).toHaveValue('Survives an eviction');
  await expectAccessible(page, 'new task failure');
  await sheet.getByTestId('quick-task-create').click();
  await expect(sheet.getByTestId('quick-task-done')).toBeVisible();

  const matching = (await items(api)).filter((item) => item.title === 'Survives an eviction');
  expect(matching).toHaveLength(1);
  await sheet.getByTestId('quick-task-close').click();
});

test('an edit after a timed-out send says the first one may have landed, and «Send as new» files the new text', async ({
  page,
}) => {
  // The first send reaches the server but never answers the client; the edited retry reuses the key.
  let isFirst = true;
  await page.route(`**/api/v1/projects/${SLUG}/items`, async (route) => {
    if (route.request().method() !== 'POST' || !isFirst) {
      await route.continue();
      return;
    }
    isFirst = false;
    await route.fetch();
    await route.abort('timedout');
  });
  await page.goto(`/p/${SLUG}/board`);
  const sheet = await openNewTask(page);
  await sheet.getByTestId('quick-task-title').fill('Timed out wording');
  await sheet.getByTestId('quick-task-create').click();
  await expect(sheet.getByTestId('quick-task-failure')).toBeVisible();

  await sheet.getByTestId('quick-task-title').fill('Edited wording');
  await sheet.getByTestId('quick-task-create').click();
  const failure = sheet.getByTestId('quick-task-failure');
  await expect(failure).toHaveAttribute('data-kind', 'key-reused');
  await expect(failure).toContainText(ru('quickTask.err.keyReused.message'));
  await expect(sheet.getByTestId('quick-task-title')).toHaveValue('Edited wording');
  await expectAccessible(page, 'new task key reused');

  await failure.getByTestId('quick-task-send-as-new').click();
  await expect(sheet.getByTestId('quick-task-done')).toBeVisible();
  const titles = (await items(api)).map((item) => item.title);
  expect(titles.filter((title) => title === 'Timed out wording')).toHaveLength(1);
  expect(titles.filter((title) => title === 'Edited wording')).toHaveLength(1);
  await sheet.getByTestId('quick-task-close').click();
});

test('a sprint the server refuses as frozen offers the backlog in one tap', async ({ page }) => {
  await page.route(`**/api/v1/projects/${SLUG}/items`, async (route) => {
    const body = route.request().postDataJSON() as { sprint: number | null } | null;
    if (route.request().method() === 'POST' && body?.sprint === 2) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://team-console/problems/sprint-frozen',
          title: 'sprint-frozen',
          status: 409,
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/p/${SLUG}/artifacts`);
  const sheet = await openNewTask(page);
  await sheet.getByTestId('quick-task-title').fill('Too late for Sprint 02');
  await sheet.getByTestId('quick-task-create').click();
  const failure = sheet.getByTestId('quick-task-failure');
  await expect(failure).toContainText(ru('quickTask.err.frozen.title', { sprint: 'Sprint 02' }));
  await expect(sheet.locator('label[data-target="next"]')).toHaveClass(/tc-choice--off/);
  await failure.getByTestId('quick-task-to-backlog').click();
  await expect(sheet).toContainText(ru('quickTask.done.backlog'));
  const created = (await items(api)).find((item) => item.title === 'Too late for Sprint 02');
  expect(created).toMatchObject({ sprint: null, status: 'proposed' });
});

test('an identity the tracker refuses never sees New task', async ({ page }) => {
  await page.route(`**/api/v1/projects/${SLUG}/sprints`, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://team-console/problems/owner-only',
        title: 'owner-only',
        status: 403,
      }),
    }),
  );
  const refused = page.waitForResponse((response) => response.url().endsWith(`/projects/${SLUG}/sprints`));
  await page.goto(`/p/${SLUG}/board`);
  await refused;
  await expect(page.getByTestId('commands-open')).toBeVisible();
  await expect(entry(page)).toHaveCount(0);
  await page.keyboard.press('t');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
