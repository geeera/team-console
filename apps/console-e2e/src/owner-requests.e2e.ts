import type { Page } from '@playwright/test';
import { addDays, calendarDayOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * Requests to the PM (#219, ADR 0005): from the Commands panel the owner picks an issue, asks for the next sprint,
 * and the console posts exactly one `pt-owner-request` comment on the owner's token — no milestone, label or status
 * write; the board row then says «ждёт PM» until the team's app answers with the handled marker; an issue moved
 * meanwhile refills the form and writes nothing. Issue #36 is in the mock's Sprint 02; its thread lives on the fake
 * GitHub so the owner's comment and the PM's answer can be read back.
 */

const REPO = 'geeera/team-console';
const ISSUE = 36;
const TODAY = calendarDayOf(Date.now());

interface FakeComment {
  readonly id: number;
  readonly issue: number;
  readonly body: string;
  readonly author: string;
}

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

async function fakeState(
  stack: Stack,
): Promise<{ comments: FakeComment[]; milestoneWrites: unknown[]; calls: string[] }> {
  const response = await fetch(`${stack.fakeURL ?? ''}/_fake/state`);
  return (await response.json()) as { comments: FakeComment[]; milestoneWrites: unknown[]; calls: string[] };
}

async function openPanel(page: Page): Promise<void> {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('issues-group')).toBeVisible();
}

// On the phone the Commands panel is a sheet too: the request dialog is the one on top.
const dialog = (page: Page) => page.getByRole('dialog').last();

async function openForm(page: Page): Promise<void> {
  await openPanel(page);
  await page.getByTestId('ask-command').click();
  await expect(dialog(page).getByRole('heading', { name: ru('commands.pick.title') })).toBeVisible();
  await dialog(page).getByLabel(ru('commands.pick.find')).fill(String(ISSUE));
  await dialog(page).locator(`tc-list-row[data-number="${ISSUE}"] button`).click();
  await expect(dialog(page).getByTestId('request-now')).toHaveText(
    ru('commands.request.now', { where: 'Sprint 02' }),
  );
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

test('asks the PM for the next sprint: one owner comment, nothing else written, «ждёт PM» until the PM answers', async ({
  page,
  stack,
}) => {
  const before = await fakeState(stack);
  await openForm(page);
  const form = dialog(page);
  await expect(form).toContainText(ru('commands.request.reads'));
  await expect(form.getByTestId('request-ok')).toHaveText(ru('commands.request.okNone'));
  await expectAccessible(page, 'Ask the PM form');

  await form.getByLabel(ru('commands.request.next', { sprint: 'Sprint 03' })).check();
  await expect(form.getByTestId('request-diff')).toHaveText(
    ru('commands.request.diff', { what: ru('commands.request.dSprint', { sprint: 'Sprint 03' }) }),
  );
  await form.getByTestId('request-ok').click();
  await expect(page.getByRole('dialog', { name: new RegExp(`^#${ISSUE} `) })).toHaveCount(0);
  await expect(page.locator('.cp-result')).toContainText(ru('commands.request.done', { n: ISSUE }));
  await expect(page.locator('.cp-result')).toContainText(ru('commands.request.doneDetail'));
  await expect(page.getByTestId('ask-pending')).toHaveText(ru('commands.ask.pending', { n: 1 }));

  const after = await fakeState(stack);
  const posted = after.comments.slice(before.comments.length);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ issue: ISSUE, author: 'geeera' });
  expect(posted[0]?.body.split('\n')[0]).toBe(
    '<!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->',
  );
  expect(after.milestoneWrites).toHaveLength(before.milestoneWrites.length);
  const newCalls = after.calls.slice(before.calls.length).filter((call) => !call.startsWith('GET '));
  expect(
    newCalls.every((call) => call.endsWith(`/issues/${ISSUE}/comments`) || call.includes('/login/oauth/')),
  ).toBe(true);

  await page.goto('/p/team-console/board');
  await showLaneOf(page, ISSUE);
  await expect(
    page.locator(`tc-list-row[data-number="${ISSUE}"] [data-testid="request-pending"]`),
  ).toHaveText(ru('board.pending'));
  await expectAccessible(page, 'Board with a request waiting for the PM');

  // The team's app answers; the form's re-read finds the marker and the board stops waiting.
  await fakePost(stack, '/_fake/comment', {
    repo: REPO,
    number: ISSUE,
    body: `<!-- pt-owner-request-handled {"comment_id":${posted[0]?.id ?? 0},"result":"applied","v":1} -->\n**PM note**: done.`,
    author: 'team-console-team[bot]',
    authorType: 'Bot',
    createdAt: Date.now() + 1000,
  });
  await openForm(page);
  await expect(dialog(page).getByTestId('request-previous')).toHaveAttribute('data-state', 'applied');
  await dialog(page)
    .getByRole('button', { name: ru('commands.dialog.cancel') })
    .click();
  await page.goto('/p/team-console/board');
  await showLaneOf(page, ISSUE);
  await expect(page.locator(`tc-list-row[data-number="${ISSUE}"]`)).toBeVisible();
  await expect(
    page.locator(`tc-list-row[data-number="${ISSUE}"] [data-testid="request-pending"]`),
  ).toHaveCount(0);
});

/**
 * The board shows five rows per lane and, on a narrow screen, one lane at a time (#275): open every lane's list, then
 * pick the lane that holds issue `number`.
 */
async function showLaneOf(page: Page, number: number): Promise<void> {
  await expect(page.locator('tc-lanes')).toBeAttached();
  for (const more of await page.locator('tc-lanes [data-testid="show-more"][aria-expanded="false"]').all()) {
    await more.dispatchEvent('click');
  }
  const lane = page.locator(`tc-lanes tc-lane:has(tc-list-row[data-number="${number}"])`);
  await expect(lane).toBeAttached();
  const id = await lane.getAttribute('id');
  const cell = page.locator(`.tc-lanes__cell[aria-controls="${id ?? ''}"]`);
  if ((await cell.count()) > 0) {
    await cell.click();
  }
}

test('an issue the PM moved meanwhile refills the form and writes nothing', async ({ page, stack }) => {
  await openForm(page);
  await fakePost(stack, '/_fake/issue-update', { repo: REPO, number: ISSUE, milestone: 'Sprint 03' });
  const before = await fakeState(stack);
  const form = dialog(page);
  await form.getByLabel(ru('commands.request.up')).check();
  await form.getByTestId('request-ok').click();
  await expect(form.getByTestId('request-error')).toContainText('Sprint 03');
  await expect(form.getByTestId('request-now')).toHaveText(
    ru('commands.request.now', { where: 'Sprint 03' }),
  );
  expect((await fakeState(stack)).comments).toHaveLength(before.comments.length);
  await expectAccessible(page, 'Ask the PM form after a conflict');
});
