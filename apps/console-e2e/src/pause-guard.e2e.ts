import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { fakeComments, seed, type Stack } from './support/stack';

/**
 * A console pause the team would not keep (#141): in a run log the team's bot opened, the plugin does not count the
 * owner's own pause, so the next scheduled run after an owner `/resume` lifts it. The panel says so — Pause is off
 * with the reason and writes nothing — and a pause already in such a log is never shown as "paused by you". An
 * owner-opened log pauses as before (all-projects-commands.e2e.ts covers that write).
 */

const REPO = 'geeera/team-console';
const LOG = 22;
const BOT = 'team-console-team[bot]';
const DAY = 24 * 60 * 60 * 1000;
/** The pause the console writes on the owner's token: `runlog pause`'s markers (golden-tested in @worker/run-log). */
const OWNER_PAUSE =
  '<!-- pt-paused -->\n<!-- pt-owner-pause {"reason": "vacation", "source": "team-console"} -->\n' +
  '**Development paused by the owner**';

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

async function seedRunLog(stack: Stack, author: string, labels: readonly string[]): Promise<void> {
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: LOG,
    title: 'Team run log',
    author,
    labels: ['team:run-log', ...labels],
    repoOwner: { login: 'geeera', id: 100001 },
  });
}

async function comment(stack: Stack, body: string, author: string, createdAt: number): Promise<void> {
  await fakePost(stack, '/_fake/comment', { repo: REPO, number: LOG, body, author, createdAt });
}

async function openPanel(page: Page): Promise<void> {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('team-state')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, [REPO]);
});

// The fake GitHub outlives `seed`: leave the owner-opened, running log the other specs of this worker expect.
test.afterAll(async ({ stack }) => {
  if (stack.isLocal) {
    await seedRunLog(stack, 'geeera', []);
  }
});

test('a run log the team bot opened: Pause is off, says why and writes nothing', async ({ page, stack }) => {
  await seedRunLog(stack, BOT, []);
  await openPanel(page);
  await expect(page.getByTestId('team-state')).toHaveText(ru('commands.status.running'));

  const pause = page.getByTestId('team-command');
  await expect(pause).toHaveAccessibleName(ru('commands.pause.title'));
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  const why = page.getByTestId('team-why');
  await expect(why).toHaveText(ru('commands.why.pauseUnreliable'));
  await expect(pause).toHaveAttribute(
    'aria-describedby',
    new RegExp(`^${(await why.getAttribute('id')) ?? '-'} `),
  );
  await expectAccessible(page, 'Commands with Pause off: the team opened the run log');

  const before = (await fakeComments(stack, LOG)).length;
  // An off command stays focusable and says why instead of acting (aria-disabled, so Playwright needs force).
  await pause.click({ force: true });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await fakeComments(stack, LOG)).length).toBe(before);
});

test('an owner pause the team does not count is shown as lifted at the next run, and Resume works', async ({
  page,
  stack,
}) => {
  // The issue's reproduction: a team auto-pause by the bot, an owner /resume, then the owner's own pause.
  const now = Date.now();
  await seedRunLog(stack, BOT, ['team:paused']);
  await comment(stack, '<!-- pt-paused -->\n**Team paused**: 3 failed runs in a row.', BOT, now - 11 * DAY);
  await comment(stack, '/resume', 'geeera', now - 10 * DAY);
  await comment(stack, OWNER_PAUSE, 'geeera', now - DAY);

  await openPanel(page);
  await expect(page.getByTestId('team-state')).toHaveText(ru('commands.status.lifts'));
  await expect(page.getByTestId('paused-banner')).toContainText(ru('commands.banner.liftsRest'));
  await expectAccessible(page, 'Commands with a pause the team does not count');

  const resume = page.getByTestId('team-command');
  await expect(resume).toHaveAccessibleName(ru('commands.resume.title'));
  await expect(resume).not.toHaveAttribute('aria-disabled', 'true');
  await resume.click();
  const confirm = page.getByRole('alertdialog');
  await confirm.locator('.tc-confirm__ok').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('team-state')).toHaveText(ru('commands.status.running'));
  expect((await fakeComments(stack, LOG)).at(-1)?.body.startsWith('<!-- pt-owner-resume -->')).toBe(true);
});

test('an owner-opened log with the same history: paused by you, and the pause holds', async ({
  page,
  stack,
}) => {
  const now = Date.now();
  await seedRunLog(stack, 'geeera', ['team:paused']);
  await comment(stack, '<!-- pt-paused -->\n**Team paused**: 3 failed runs in a row.', BOT, now - 11 * DAY);
  await comment(stack, '/resume', 'geeera', now - 10 * DAY);
  await comment(stack, OWNER_PAUSE, 'geeera', now - DAY);

  await openPanel(page);
  await expect(page.getByTestId('team-state')).toContainText(ru('commands.status.ownerNoTime'));
  await expect(page.getByTestId('paused-banner')).toContainText(ru('commands.banner.ownerRest'));
});
