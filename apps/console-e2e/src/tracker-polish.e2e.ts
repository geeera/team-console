import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, localD1, switchToConsoleTracker } from './support/tracker-seed';

/**
 * Console tracker polish after #435 (#457): approving `TC-n` items in a batch and from a notification's question
 * screen records owner decisions that name the open ask (never the GitHub answer routes); the task screen's decision
 * card does not repeat the title; a sprint is created with the owner's name; a long project name ends in "…" in the
 * phone's top bar. Asks are job writes (Phase 2), so the spec writes them into the worker's own local D1.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'team-console';
const LONG_NAME = 'Team Console — the very long product name of a project with a lot to say';
const DECISIONS = /\/api\/v1\/projects\/team-console\/items\/(\d+)\/decisions$/;
const GITHUB_ANSWERS = /\/api\/v1\/projects\/[^/]+\/(answers\/batch|issues\/\d+\/answer)/;

async function askOn(workerIndex: number, item: number, text: string): Promise<void> {
  await localD1(
    workerIndex,
    `INSERT INTO asks (project_slug, item_id, category, ask, commands, recommended, created_at, source)
     SELECT '${SLUG}', id, 'scope', '${text}', '["approve","reject"]', 'approve', '2026-11-05T09:00:00.000Z', 'console'
     FROM items WHERE project_slug = '${SLUG}' AND number = ${String(item)}`,
  );
}

/** Each case's own items, each waiting on a scope question the team recommends approving. */
async function waitingItems(stack: Parameters<typeof apiClient>[0], workerIndex: number, titles: string[]) {
  const api = await apiClient(stack);
  const numbers: number[] = [];
  try {
    for (const title of titles) {
      numbers.push(await createItem(api, SLUG, { title, kind: 'question' }));
    }
  } finally {
    await api.dispose();
  }
  for (const number of numbers) {
    await askOn(workerIndex, number, `Take ${String(number)} into the sprint?`);
  }
  return numbers;
}

test.beforeEach(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
});

test('batch approve records a decision per TC item naming its open ask, never a GitHub answer', async ({
  page,
  stack,
}, testInfo) => {
  const numbers = await waitingItems(stack, testInfo.workerIndex, ['Stamp sound', 'Paper grain']);
  const decisions: { number: number; body: unknown; key: string | undefined }[] = [];
  const github: string[] = [];
  page.on('request', (request) => {
    const match = DECISIONS.exec(new URL(request.url()).pathname);
    if (request.method() === 'POST' && match !== null) {
      decisions.push({
        number: Number(match[1]),
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
    }
    if (request.method() === 'POST' && GITHUB_ANSWERS.test(new URL(request.url()).pathname)) {
      github.push(request.url());
    }
  });

  await page.goto('/needs-you');
  const open = page.getByTestId('batch-approve');
  await expect(open).toHaveText(ru('commands.batch.approve', { n: 2 }));
  await open.click();
  const dialog = page.getByRole('alertdialog', { name: ru('commands.batch.title') });
  for (const number of numbers) {
    await expect(dialog.locator(`[data-number="${String(number)}"] input`)).toBeChecked();
  }
  await expectAccessible(page, 'batch dialog with TC items');
  await dialog.getByTestId('batch-ok').click();
  await expect(dialog).toBeHidden();

  expect(github).toEqual([]);
  expect(decisions.map((decision) => decision.number).sort()).toEqual([...numbers].sort());
  for (const decision of decisions) {
    expect(decision.body).toEqual({
      command: 'approve',
      text: ru('commands.batch.ownerSaid', { n: 2 }),
      askId: expect.any(Number),
      reversesCommentId: null,
      via: 'web',
    });
    expect(decision.key).toMatch(/^[0-9a-f-]{36}$/);
  }
  for (const number of numbers) {
    await expect(page.locator(`li[data-number="${String(number)}"]`)).toHaveCount(0);
  }
  // Recorded on the item: its history says the owner approved it.
  await page.goto(`/p/${SLUG}/t/${String(numbers[0])}`);
  await expect(page.getByTestId('task-history')).toContainText(ru('item.ev.approved'));
});

test("a notification's question screen approves a TC item with a decision naming its open ask", async ({
  page,
  stack,
}, testInfo) => {
  const [number] = await waitingItems(stack, testInfo.workerIndex, ['Stamp sound']);
  const github: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && GITHUB_ANSWERS.test(new URL(request.url()).pathname)) {
      github.push(request.url());
    }
  });
  // The tap target a push opens (`/p/{slug}/questions#{n}`, #36).
  await page.goto(`/p/${SLUG}/questions#${String(number)}`);
  const card = page.locator(`li[data-number="${String(number)}"]`);
  await expect(card).toContainText(`TC-${String(number)}`);
  const decided = page.waitForRequest(
    (request) => request.method() === 'POST' && DECISIONS.test(new URL(request.url()).pathname),
  );
  await card.getByRole('button', { name: ru('answer.command.approve') }).click();
  expect((await decided).postDataJSON()).toMatchObject({ command: 'approve', askId: expect.any(Number) });
  await expect(page.locator(`[data-receipt="${SLUG}#${String(number)}"]`)).toBeVisible();
  expect(github).toEqual([]);
});

test('the task screen decision card reads "Waiting for your decision", not the title again', async ({
  page,
  stack,
}, testInfo) => {
  const [number] = await waitingItems(stack, testInfo.workerIndex, ['A paper sound on the stamp']);
  await page.goto(`/p/${SLUG}/t/${String(number)}`);
  await expect(page.getByTestId('task-title')).toHaveText('A paper sound on the stamp');
  const card = page.getByTestId('task-decision');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText(ru('item.decisionHeading'));
  await expect(card.getByRole('article')).toHaveAccessibleName(ru('item.decisionHeading'));
  await expect(card).not.toContainText('A paper sound on the stamp');
  await expect(card).toContainText(`Take ${String(number)} into the sprint?`);
  await expectAccessible(page, 'task decision card');
});

test("creates a sprint with the owner's name, refusing a name already taken", async ({ page, stack }) => {
  const api = await apiClient(stack);
  try {
    await createSprint(api, SLUG, '2030-01-15');
  } finally {
    await api.dispose();
  }
  await page.goto(`/p/${SLUG}/board`);
  await page.getByTestId('create-sprint').click();
  const dialog = page.getByRole('dialog', { name: ru('sprintNew.title') });
  const name = dialog.getByLabel(ru('sprintNew.name'));
  await expect(name).toHaveValue('Sprint 02');
  await expect(dialog).toContainText('Спринт начнётся после демо Sprint 01 (15 января)');
  await expect(dialog).toContainText('Заморозка перед демо: 27–29 января');

  await name.fill('sprint 01');
  await expect(dialog).toContainText(ru('sprintNew.errName'));
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page, 'create sprint with a taken name');

  await name.fill('Sprint 02 · Checkout');
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith(`/projects/${SLUG}/sprints`),
  );
  await dialog.getByRole('button', { name: 'Создать Sprint 02 · Checkout' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ dueOn: '2030-01-29', title: 'Sprint 02 · Checkout' });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Sprint 02 · Checkout создан' })).toBeVisible();
});

test('a long project name ends in an ellipsis in the top bar instead of running under the controls', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'the top bar is the phone layout (390 px)');
  await localD1(
    testInfo.workerIndex,
    `UPDATE projects SET display_name = '${LONG_NAME}' WHERE slug = '${SLUG}'`,
  );
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/p/${SLUG}/board`);
    const name = page.locator('.shell__switch-name');
    await expect(name).toHaveText(LONG_NAME);
    const box = await name.evaluate((element) => {
      const style = getComputedStyle(element);
      const actions = document.querySelector('.shell__actions')?.getBoundingClientRect();
      return {
        overflow: style.textOverflow,
        isCut: element.scrollWidth > element.clientWidth,
        right: element.getBoundingClientRect().right,
        actionsLeft: actions?.left ?? 0,
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      };
    });
    expect(box.overflow).toBe('ellipsis');
    expect(box.isCut).toBe(true);
    expect(box.right).toBeLessThanOrEqual(box.actionsLeft);
    expect(box.pageWidth).toBeLessThanOrEqual(box.viewport);
    // The whole name stays the button's: the switcher still says which project it is.
    await expect(page.getByRole('button', { name: ru('shell.openSwitcher') })).toBeVisible();
  }
});

test('at 390 px the Commands label is an icon and the Local badge shrinks, giving the name its room back (#470 item 1)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'the top bar is the phone layout (390 px)');
  await page.goto(`/p/${SLUG}/board`);
  const badge = page.getByTestId('environment-mark');
  await expect(badge).toContainText('Local');
  const commandsLabel = page.locator('[data-testid="commands-open"] .space__commands-phone-label');
  const commandsButton = page.getByTestId('commands-open');
  const [badgeBox, labelDisplay] = await Promise.all([
    badge.evaluate((element) => getComputedStyle(element).fontSize),
    commandsLabel.evaluate((element) => getComputedStyle(element).display),
  ]);
  // 11px (--fs-2xs), not the ordinary chip's 12px (--fs-xs): the badge gave up some of its own room too.
  expect(badgeBox).toBe('11px');
  expect(labelDisplay).toBe('none');
  // The icon-only button still names itself for assistive tech and stays reachable.
  await expect(commandsButton).toHaveAccessibleName(ru('commands.openAria', { name: SLUG }));
  await expectAccessible(page, 'phone top bar at 390 px');
});
