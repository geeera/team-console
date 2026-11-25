import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { localD1, switchToConsoleTracker } from './support/tracker-seed';

/**
 * An Actions project's workflow drift on Needs you (#874) end to end on the local stack. The stored judgement
 * (migration 0041) is written straight into the worker's local D1, as the readiness check or a failed dispatch would;
 * Needs you reads it with no GitHub call, says when it was checked, and leads to the project's Actions setup page.
 */

const SLUG = 'team-console';

/** Fixed spec constants, never input. */
async function storeJudgement(workerIndex: number, dispatch: 'pull' | 'actions', status: 'modified' | 'ok'): Promise<void> {
  await localD1(
    workerIndex,
    `UPDATE projects SET dispatch = '${dispatch}', actions_workflow_status = '${status}', actions_workflow_sha256 = NULL,
       actions_workflow_checked_at = '2026-11-20T09:00:00.000Z' WHERE slug = '${SLUG}'`,
  );
}

async function displayNameOf(stack: Parameters<typeof apiClient>[0]): Promise<string> {
  const api = await apiClient(stack);
  try {
    const projects = (await (await api.get('/api/v1/projects')).json()) as { slug: string; displayName: string }[];
    return projects.find((project) => project.slug === SLUG)?.displayName ?? SLUG;
  } finally {
    await api.dispose();
  }
}

test.beforeEach(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, [`geeera/${SLUG}`]);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
});

test('a drifted workflow is one row on Needs you, with when it was checked, to the Actions setup page', async ({
  page,
  stack,
}, testInfo) => {
  await storeJudgement(testInfo.workerIndex, 'actions', 'modified');
  const name = await displayNameOf(stack);

  await page.goto('/needs-you');
  const row = page.getByTestId('actions-drift');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(ru('needsYou.attention.actionsDrift.broken', { name }));
  await expect(row.getByTestId('actions-drift-checked')).toHaveText(/^Проверено 20 ноября в \d{2}:\d{2}$/);
  await expect(page.getByTestId('empty')).toHaveCount(0);
  await expectAccessible(page, 'Needs you, Actions workflow drift');
  await page.getByTestId('project-attention').screenshot({ path: testInfo.outputPath('needs-you-actions-drift.png') });

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}/actions$`));
  await expect(page.getByRole('heading', { level: 1, name: ru('actions.title') })).toBeVisible();
});

test('no row once the project is back on pull, or its file was last found ok', async ({ page }, testInfo) => {
  await storeJudgement(testInfo.workerIndex, 'pull', 'modified');
  await page.goto('/needs-you');
  await expect(page.getByTestId('lead').or(page.getByTestId('empty')).first()).toBeVisible();
  await expect(page.getByTestId('actions-drift')).toHaveCount(0);

  await storeJudgement(testInfo.workerIndex, 'actions', 'ok');
  await page.reload();
  await expect(page.getByTestId('lead').or(page.getByTestId('empty')).first()).toBeVisible();
  await expect(page.getByTestId('actions-drift')).toHaveCount(0);
});
