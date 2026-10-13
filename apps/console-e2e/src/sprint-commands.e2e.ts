import type { Locator, Page } from '@playwright/test';
import { addDays, calendarDayOf } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * Sprint commands (#218): the status card shows the sprint with its demo, freeze and progress; "Move the demo"
 * refuses a past date and one on or after the next demo, shows the freeze of the chosen date and warns when it starts
 * at once, and writes `due_on` exactly as `backlog sprint create` does; "Start the next sprint" creates Sprint NN+1
 * two weeks after the current demo and is not offered once it exists; a demo moved meanwhile refills the form and
 * writes nothing; the board's "Move demo" opens the same dialog. Milestones live on the fake GitHub, dated from today
 * in Kyiv, so the spec runs on any day.
 */

const REPO = 'geeera/team-console';
const TODAY = calendarDayOf(Date.now());
const DUE = addDays(TODAY, 9);

interface FakeMilestone {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly dueOn: string | null;
}

interface FakeWrite {
  readonly method: string;
  readonly number: number | null;
  readonly body: string;
}

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

async function seedSprints(stack: Stack, due: string): Promise<void> {
  await fakePost(stack, '/_fake/milestones', {
    repo: REPO,
    milestones: [
      { number: 1, title: 'Sprint 01', state: 'closed', dueOn: `${addDays(TODAY, -5)}T12:00:00Z` },
      { number: 2, title: 'Sprint 02', state: 'open', dueOn: `${due}T12:00:00Z` },
    ],
  });
}

async function milestones(stack: Stack): Promise<FakeMilestone[]> {
  const response = await fetch(`${stack.fakeURL ?? ''}/_fake/milestones?repo=${encodeURIComponent(REPO)}`);
  return (await response.json()) as FakeMilestone[];
}

async function writes(stack: Stack): Promise<FakeWrite[]> {
  const response = await fetch(`${stack.fakeURL ?? ''}/_fake/state`);
  return ((await response.json()) as { milestoneWrites: FakeWrite[] }).milestoneWrites;
}

async function openPanel(page: Page): Promise<void> {
  await page.goto('/p/team-console/questions');
  await page.getByTestId('commands-open').click();
  await expect(page.getByTestId('status-sprint')).toContainText('Sprint 02');
}

const dialog = (page: Page) => page.getByRole('alertdialog');
const dateField = (page: Page) => dialog(page).getByLabel(ru('commands.demo.field'));
/** The kit DatePicker's typed form (#307): `ДД.ММ.ГГГГ`. */
const shown = (day: string): string => day.split('-').reverse().join('.');

/** Types a day into the date field and leaves it, as the owner does: the field reads typed text on blur. */
async function typeDate(field: Locator, day: string): Promise<void> {
  await field.fill(shown(day));
  await field.blur();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  // The status card reads the run log; an empty one owned by the owner is enough.
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: 22,
    title: 'Team run log',
    author: 'geeera',
    labels: ['team:run-log'],
    repoOwner: { login: 'geeera', id: 100001 },
  });
});

// A fresh api isolate each time: no sprint cached by the test before (the status read keeps it a minute).
test.beforeEach(async ({ stack }) => {
  await seedSprints(stack, DUE);
  await seed(stack, [REPO]);
});

// The fake GitHub outlives this spec: leave the mock's own milestones for the next spec of this worker.
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

test('the status card shows the sprint with its demo, freeze and progress', async ({ page }) => {
  await openPanel(page);
  await expect(page.getByTestId('status-sprint')).toContainText(`Sprint 02 · демо`);
  await expect(page.getByTestId('status-sprint')).toContainText('заморозка');
  await expect(page.getByTestId('status-progress')).toHaveText(/^\d+ из \d+$/);
  const group = page.getByTestId('sprint-group');
  await expect(group.getByRole('heading', { name: ru('commands.group.sprint') })).toBeVisible();
  await expect(
    group.getByRole('button', { name: ru('commands.sprint.demoAria', { sprint: 'Sprint 02' }) }),
  ).toBeVisible();
  await expect(
    group.getByRole('button', { name: ru('commands.sprint.nextAria', { sprint: 'Sprint 03' }) }),
  ).toBeVisible();
  await expectAccessible(page, 'Commands panel with the Sprint group');
});

test('Move the demo refuses a past date, warns when the freeze starts at once, and writes due_on', async ({
  page,
  stack,
}) => {
  const before = (await writes(stack)).length;
  await openPanel(page);
  await page.getByTestId('sprint-demo').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dateField(page)).toHaveValue(shown(DUE));
  const ok = dialog(page).locator('.tc-confirm__ok');
  await expect(ok).toHaveText(ru('commands.demo.same'));

  await typeDate(dateField(page), addDays(TODAY, -1));
  await expect(dateField(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog(page)).toContainText(ru('commands.demo.past'));
  await expect(ok).toHaveAttribute('aria-disabled', 'true');

  await typeDate(dateField(page), addDays(TODAY, 1));
  await expect(dialog(page)).toContainText(ru('commands.demo.freezeNow'));
  await expectAccessible(page, 'Move the demo with the freeze warning');

  const moved = addDays(TODAY, 11);
  await typeDate(dateField(page), moved);
  await expect(dialog(page)).not.toContainText(ru('commands.demo.freezeNow'));
  await ok.click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.cp-result')).toContainText('Демо Sprint 02 перенесено на');

  const after = (await writes(stack)).slice(before);
  expect(after).toEqual([
    expect.objectContaining({ method: 'PATCH', number: 2, body: `{"due_on":"${moved}T12:00:00Z"}` }),
  ]);
  expect((await milestones(stack)).find((m) => m.number === 2)?.dueOn).toBe(`${moved}T12:00:00Z`);
  await expect(page.getByTestId('status-sprint')).toContainText(String(Number(moved.slice(8, 10))));
});

test('a demo moved meanwhile refills the form with the live date and writes nothing', async ({
  page,
  stack,
}) => {
  await openPanel(page);
  await page.getByTestId('sprint-demo').click();
  await expect(dateField(page)).toHaveValue(shown(DUE));
  // The PM moves the demo while the dialog is open.
  const live = addDays(DUE, 1);
  await seedSprints(stack, live);
  const before = (await writes(stack)).length;

  await typeDate(dateField(page), addDays(DUE, 3));
  await dialog(page).locator('.tc-confirm__ok').click();
  await expect(dialog(page).getByRole('alert')).toContainText('Дату демо изменили, пока диалог был открыт');
  await expect(dateField(page)).toHaveValue(shown(live));
  expect((await writes(stack)).length).toBe(before);
  await dialog(page).locator('.tc-confirm__cancel').click();
});

test('Start the next sprint creates Sprint 03 two weeks after the demo, then is not offered', async ({
  page,
  stack,
}) => {
  const before = (await writes(stack)).length;
  await openPanel(page);
  await page.getByTestId('sprint-next').click();
  await expect(dialog(page)).toContainText('Начать Sprint 03?');
  const field = dialog(page).getByLabel(ru('commands.next.field', { sprint: 'Sprint 03' }));
  const due = addDays(DUE, 14);
  await expect(field).toHaveValue(shown(due));
  await typeDate(field, DUE);
  await expect(dialog(page)).toContainText('Демо Sprint 03 должно быть позже');
  await typeDate(field, due);
  await dialog(page)
    .getByRole('button', { name: ru('commands.next.ok', { sprint: 'Sprint 03' }) })
    .click();
  await expect(page.locator('.cp-result')).toContainText(ru('commands.next.done', { sprint: 'Sprint 03' }));

  expect((await writes(stack)).slice(before)).toEqual([
    expect.objectContaining({ method: 'POST', body: `{"title":"Sprint 03","due_on":"${due}T12:00:00Z"}` }),
  ]);
  await expect(page.getByTestId('sprint-next')).toHaveCount(0);
  await expect(page.locator('[data-sprint="next"]')).toContainText('Sprint 03 уже создан');
});

test('the board has Move demo by the sprint title, opening the same dialog', async ({ page }) => {
  await page.goto('/p/team-console/board');
  const move = page.getByTestId('board-move-demo');
  await expect(move).toHaveAccessibleName(ru('commands.sprint.demoAria', { sprint: 'Sprint 02' }));
  await move.click();
  await expect(dialog(page)).toContainText(ru('commands.demo.title', { sprint: 'Sprint 02' }));
  await expect(dateField(page)).toHaveValue(shown(DUE));
  await expectAccessible(page, 'Move the demo from the board');
  await dialog(page).locator('.tc-confirm__cancel').click();
  await expect(dialog(page)).toHaveCount(0);
});
