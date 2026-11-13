import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { apiClient, seed } from './support/stack';
import { createItem, createSprint, localD1, switchToConsoleTracker } from './support/tracker-seed';

/**
 * The board of a console-tracker project (#556): the current sprint and its tasks come from the tracker, and the
 * server refuses a move into a sprint during its freeze. The current sprint's demo is tomorrow, so it is frozen.
 */

const SLUG = 'team-console';
let inSprint = 0;
let inBacklog = 0;

test.describe.configure({ mode: 'serial' });

/** Tomorrow in Kyiv, where the plugin counts sprint days. */
function tomorrow(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(Date.now() + 86_400_000));
}

test.beforeAll(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    const sprint = await createSprint(api, SLUG, tomorrow());
    // Sprint 1 is already frozen (its demo is tomorrow), so #560 refuses a creation straight into it; plant the
    // item in the backlog first, as if it had been planned before the freeze started, then move it by SQL.
    inSprint = await createItem(api, SLUG, { title: 'Board reads the tracker', status: 'in-progress', sprint: null });
    await localD1(
      testInfo.workerIndex,
      `UPDATE items SET sprint_id = (SELECT id FROM sprints WHERE project_slug = '${SLUG}' AND number = ${String(sprint)})
       WHERE project_slug = '${SLUG}' AND number = ${String(inSprint)}`,
    );
    inBacklog = await createItem(api, SLUG, { title: 'Folders for later sprints', sprint: null });
  } finally {
    await api.dispose();
  }
});

test('shows the tracker’s current sprint and its tasks by lane', async ({ page }) => {
  await page.goto(`/p/${SLUG}/board`);
  await expect(page.getByRole('heading', { level: 2, name: 'Sprint 01' })).toBeVisible();
  const lane = page.locator('tc-lane[data-status="in-progress"]');
  await expect(lane.locator(`[data-number="${String(inSprint)}"]`)).toContainText('Board reads the tracker');
  await expect(page.locator(`[data-number="${String(inBacklog)}"]`)).toHaveCount(0);
  await expectAccessible(page, 'tracker board');
});

test('refuses a move into the frozen sprint and still moves a task out of it', async ({ stack }) => {
  const api = await apiClient(stack);
  try {
    const move = async (number: number, sprint: number | null) => {
      const path = `/api/v1/projects/${SLUG}/items/${String(number)}`;
      const etag = (await api.get(path)).headers()['etag'] ?? '';
      return api.patch(path, {
        data: { sprint },
        headers: { 'Idempotency-Key': crypto.randomUUID(), 'If-Match': etag },
      });
    };
    const into = await move(inBacklog, 1);
    expect(into.status()).toBe(409);
    expect(((await into.json()) as { type: string }).type).toMatch(/\/sprint-frozen$/);
    const out = await move(inSprint, null);
    expect(out.status()).toBe(200);
  } finally {
    await api.dispose();
  }
});
