import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, fakeComments, seed, type Stack } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * Commands from All projects (#222, #29 slice 5): every card has its own Commands, opening the same panel as the
 * project space — a pane on a wide screen, a sheet on the phone — so a command from here writes exactly what it
 * writes from the space. On a wide screen K opens the panel for the focused card and leaves typing alone; closing
 * returns focus to that card's button. A snoozed project's card shows the struck bell and the words.
 */

const REPO = 'geeera/team-console';
const RUN_LOG = 22;
const SNOOZE = '/api/v1/projects/private-product/notifications/snooze';
const isWide = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 520;

const cardOf = (page: Page, slug: string): Locator => page.locator(`[data-card-slug="${slug}"]`);
const commandsFor = (page: Page, name: string): Locator =>
  page.getByRole('button', { name: ru('commands.openAria', { name }), exact: true });
/** The pane on a wide screen, the sheet on the phone: the same panel either way. */
const panelOf = (page: Page): Locator =>
  isWide(page) ? page.locator('#tc-overview-commands') : page.getByRole('dialog');

/** The card's project name as the registry gives it. */
async function nameOf(page: Page, slug: string): Promise<string> {
  return ((await cardOf(page, slug).locator('.ov__name').textContent()) ?? '').trim();
}

async function openOverview(page: Page): Promise<void> {
  await page.goto('/overview');
  await expect(page.getByTestId('overview-row')).toHaveCount(2);
}

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  // The panel's status card reads the run log; the owner's pause lands on it as on GitHub.
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: RUN_LOG,
    title: 'Team run log',
    author: 'geeera',
    labels: ['team:run-log'],
    repoOwner: { login: 'geeera', id: 100001 },
  });
  await seed(stack, [REPO, 'geeera/private-product']);
});

// The fake GitHub outlives `seed`: resume, so later specs of this worker find the team running again.
test.afterAll(async ({ stack }) => {
  if (!stack.isLocal) {
    return;
  }
  const api = await apiClient(stack);
  try {
    const status = await api.get('/api/v1/projects/team-console/team/status');
    const body = (await status.json()) as { state?: string };
    if (body.state === 'paused-by-owner') {
      const resumed = await api.post('/api/v1/projects/team-console/team/resume', { data: {} });
      expect(resumed.status(), await resumed.text()).toBe(201);
    }
  } finally {
    await api.dispose();
  }
});

test('every card opens the same Commands panel; Pause from here writes the run log as from the space', async ({
  page,
  stack,
}) => {
  await openOverview(page);
  for (const slug of ['team-console', 'private-product']) {
    const button = commandsFor(page, await nameOf(page, slug));
    await expect(button).toBeVisible();
    await expect(button).toContainText(ru('commands.open'));
    if (!isWide(page)) {
      expect(meetsMinTap((await button.boundingBox())?.height), 'the phone tap target').toBe(true);
    }
  }
  await expectAccessible(page, 'All projects with Commands on every card');

  const tcName = await nameOf(page, 'team-console');
  const open = commandsFor(page, tcName);
  await open.click();
  const panel = panelOf(page);
  await expect(panel.getByTestId('team-state')).toBeVisible();
  await expect(panel).toHaveAccessibleName(ru('commands.title', { name: tcName }));
  // The groups the space's panel has: Team, Run now, Sprint and Notifications.
  for (const group of ['team', 'run', 'sprint', 'notify']) {
    await expect(panel.getByRole('heading', { name: ru(`commands.group.${group}`), exact: true })).toBeVisible();
  }
  if (isWide(page)) {
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    // The pane is beside the page, not over it: the cards stay usable.
    await expect(cardOf(page, 'private-product').getByTestId('overview-row')).toBeVisible();
  }
  await expectAccessible(page, 'All projects, Commands open');

  const before = (await fakeComments(stack, RUN_LOG)).length;
  await panel.getByTestId('team-command').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.locator('.tc-confirm__ok').click();
  await expect(confirm).toHaveCount(0);
  await expect(panel.locator('.cp-result')).toBeVisible();
  // Pause turned into Resume: the panel took the Worker's answer, as it does in the space.
  await expect(panel.getByTestId('team-command')).toHaveAccessibleName(ru('commands.resume.title'));
  const written = await fakeComments(stack, RUN_LOG);
  expect(written.length).toBe(before + 1);
  expect(written.at(-1)?.body.startsWith('<!-- pt-paused -->\n')).toBe(true);

  // Closing returns focus to the card's Commands button.
  if (isWide(page)) {
    await panel.getByRole('button', { name: ru('commands.close') }).click();
    await expect(panel).toHaveCount(0);
    await expect(open).toHaveAttribute('aria-expanded', 'false');
  } else {
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  }
  await expect(open).toBeFocused();
});

test('K on a focused card opens that project’s panel, not while typing; Escape returns to the card', async ({
  page,
}) => {
  test.skip(!isWide(page), 'K is the Mac keyboard shortcut; the phone has no pane');
  await openOverview(page);
  await expect(page.getByRole('heading', { name: ru('overview.repos.title') })).toBeVisible();

  // Typing K into a field on the page ("Add by name") is a letter, never the shortcut.
  await page.getByTestId('by-name-toggle').click();
  const field = page.locator('#repos-by-name').getByRole('textbox').first();
  await field.focus();
  await page.keyboard.press('k');
  await expect(field).toHaveValue(/k$/);
  await expect(page.locator('#tc-overview-commands')).toHaveCount(0);

  // Off the cards K does nothing either.
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('k');
  await expect(page.locator('#tc-overview-commands')).toHaveCount(0);

  const ppName = await nameOf(page, 'private-product');
  await cardOf(page, 'private-product').getByTestId('overview-row').focus();
  await page.keyboard.press('k');
  const pane = page.locator('#tc-overview-commands');
  await expect(pane).toHaveAccessibleName(ru('commands.title', { name: ppName }));
  await expect(pane.locator('.cp__title')).toBeFocused();
  await expect(commandsFor(page, ppName)).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(commandsFor(page, ppName)).toBeFocused();

  // From the card's own button K toggles the same pane.
  await page.keyboard.press('k');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.cp__title')).toBeFocused();
  await page.keyboard.press('k');
  await expect(pane).toHaveCount(0);
  await expect(commandsFor(page, ppName)).toBeFocused();
});

test('a snoozed project’s card shows the struck bell and the words; the other card does not', async ({
  page,
  stack,
}) => {
  const api = await apiClient(stack);
  try {
    const stored = await api.put(SNOOZE, { data: { until: null, allowsUrgent: true } });
    expect(stored.status(), await stored.text()).toBe(200);
  } finally {
    await api.dispose();
  }
  await openOverview(page);
  const line = cardOf(page, 'private-product').getByTestId('snoozed');
  await expect(line).toHaveText(ru('overview.snoozed'));
  await expect(line.locator('tc-icon')).toHaveAttribute('name', 'bell-off');
  await expect(cardOf(page, 'team-console').getByTestId('snoozed')).toHaveCount(0);
  await expectAccessible(page, 'All projects with a snoozed project');

  // The same snooze in that project's panel, opened from its card.
  const ppName = await nameOf(page, 'private-product');
  await commandsFor(page, ppName).click();
  await expect(panelOf(page).getByTestId('snooze-line')).toContainText(ru('commands.snooze.forever'));
});
