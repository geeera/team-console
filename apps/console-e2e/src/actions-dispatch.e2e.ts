import type { APIRequestContext, Page } from '@playwright/test';
import type { JobDto, ProjectDispatchDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { claimStatus, enrolRunner } from './support/runner';
import { apiClient, seed } from './support/stack';
import { localD1, switchToConsoleTracker } from './support/tracker-seed';

/**
 * GitHub Actions dispatch (#670) end to end on the local stack: Settings › Runners tells the owner plainly that the
 * Actions minutes are their own spend; a subscription project is refused with the reason; Run now on an Actions
 * project is dispatched through the mock GitHub app (`actions: write` granted on geeera/team-console, not on
 * geeera/private-product), and a missing permission fails the job as `dispatch-failed: permission missing`. A pinned
 * placement is kept on an Actions project and picks the runner of its local-only jobs (#728). The phone layout is
 * checked for overflow.
 *
 * #759 PR 3: the switch to `actions` now runs the readiness check, and the local stack is never ready (it is served on
 * localhost, not on the `CONSOLE_PUBLIC_ORIGIN` its rendered workflow names), so the switch is refused here and an
 * Actions project is seeded in D1 as a ready switch would leave it. The server-side switch is covered by
 * `apps/api/src/actions/dispatch.spec.ts` and `apps/api/src/routes/actions-readiness.spec.ts`.
 */

const ACTIONS_PROJECT = 'team-console';
const NO_PERMISSION_PROJECT = 'private-product';

/** The project's team configuration moves to an API key (ADR 0009 d.3: only such a project may go to Actions). */
async function useApiKey(api: APIRequestContext, slug: string): Promise<void> {
  const response = await api.put(`/api/v1/projects/${slug}/team-config`, {
    data: { config: { schema: 'team-config/v1', access: { source: 'api_key' } } },
    headers: { 'If-Match': '"0"' },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** The project as a switch made while its repository was ready leaves it; the mock names `dev` its default branch. */
async function seedOnActions(workerIndex: number, slug: string): Promise<void> {
  await localD1(
    workerIndex,
    `UPDATE projects SET dispatch = 'actions', default_branch = 'dev' WHERE slug = '${slug}'`,
  );
}

async function runNow(api: APIRequestContext, slug: string): Promise<JobDto> {
  const response = await api.post(`/api/v1/projects/${slug}/jobs`, { data: { kind: 'slot-dev' } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as JobDto;
}

async function openDispatch(page: Page, slug: string) {
  await page.goto('/settings/runners');
  await expect(page.getByRole('heading', { level: 1, name: ru('runners.title') })).toBeFocused();
  await page.getByTestId('runners-policy-pick').selectOption(slug);
  const editor = page.getByTestId('runners-dispatch');
  await expect(editor.getByRole('heading', { name: ru('runners.dispatch.title') })).toBeVisible();
  await expect(editor.getByTestId('project-dispatch-form')).toBeVisible();
  return editor;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.beforeEach(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, [`geeera/${ACTIONS_PROJECT}`, `geeera/${NO_PERMISSION_PROJECT}`]);
  await switchToConsoleTracker(testInfo.workerIndex, ACTIONS_PROJECT, 'TC');
  await switchToConsoleTracker(testInfo.workerIndex, NO_PERMISSION_PROJECT, 'PP');
});

test('the local stack refuses the switch as not ready; an Actions project shows its branch, and Run now is dispatched', async ({
  page,
  stack,
}, testInfo) => {
  const api = await apiClient(stack);
  try {
    await useApiKey(api, ACTIONS_PROJECT);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const editor = await openDispatch(page, ACTIONS_PROJECT);

    // The stored choice, and the plain word on whose money the Actions minutes are.
    await expect(editor.getByRole('radio', { name: ru('runners.dispatch.pull') })).toBeChecked();
    const actions = editor.getByRole('radio', { name: ru('runners.dispatch.actions') });
    await expect(editor.getByTestId('project-dispatch-minutes')).toHaveText(ru('runners.dispatch.minutes'));
    await expect(actions).toHaveAccessibleDescription(
      `${ru('runners.dispatch.actionsHint')} ${ru('runners.dispatch.minutes')}`,
    );
    await expectAccessible(page, 'Settings › Runners, dispatch on pull');

    // The readiness check runs inside the switch (#759): on this stack it never passes, so nothing changes.
    await actions.check();
    await editor.getByTestId('project-dispatch-save').click();
    await expect(editor.getByTestId('project-dispatch-error')).toBeVisible();
    const refused = await api.get(`/api/v1/projects/${ACTIONS_PROJECT}/dispatch`);
    expect(((await refused.json()) as ProjectDispatchDto).dispatch).toBe('pull');

    await seedOnActions(testInfo.workerIndex, ACTIONS_PROJECT);
    const onActions = await openDispatch(page, ACTIONS_PROJECT);
    await expect(onActions.getByRole('radio', { name: ru('runners.dispatch.actions') })).toBeChecked();
    await expect(onActions.getByTestId('project-dispatch-branch')).toHaveText(
      ru('runners.dispatch.branch', { branch: 'dev' }),
    );
    await expectAccessible(page, 'Settings › Runners, dispatch on GitHub Actions');

    const stored = await api.get(`/api/v1/projects/${ACTIONS_PROJECT}/dispatch`);
    expect((await stored.json()) as ProjectDispatchDto).toEqual({
      dispatch: 'actions',
      defaultBranch: 'dev',
    });

    // Run now: the job copies the project's dispatch and the workflow_dispatch call is accepted (it stays queued
    // for its run; a failed call would have failed it).
    const job = await runNow(api, ACTIONS_PROJECT);
    expect(job.dispatch).toBe('actions');
    expect(job.state).toBe('queued');
    expect(job.result).toBeNull();
  } finally {
    await api.dispose();
  }
});

test('a subscription project is refused with the reason, and a missing actions permission fails the job', async ({
  page,
  stack,
}, testInfo) => {
  const api = await apiClient(stack);
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const editor = await openDispatch(page, NO_PERMISSION_PROJECT);
    await editor.getByRole('radio', { name: ru('runners.dispatch.actions') }).check();
    await editor.getByTestId('project-dispatch-save').click();
    const alert = editor.getByRole('alert');
    await expect(alert).toHaveText(ru('runners.err.accessSourceHosted'));
    // The refusal leads to where the access source changes: the project's Settings › Team (#688).
    await expect(editor.getByRole('link', { name: ru('runners.err.openTeam') })).toHaveAttribute(
      'href',
      `/settings/projects/${NO_PERMISSION_PROJECT}/team`,
    );
    await expectAccessible(page, 'Settings › Runners, dispatch refused for a subscription');
    const unchanged = await api.get(`/api/v1/projects/${NO_PERMISSION_PROJECT}/dispatch`);
    expect(((await unchanged.json()) as ProjectDispatchDto).dispatch).toBe('pull');

    // On an API key, as a ready switch left it; the mock app has no `actions: write` on this repository (the
    // permission went away after the switch, which the dispatch still judges on its own).
    await useApiKey(api, NO_PERMISSION_PROJECT);
    await seedOnActions(testInfo.workerIndex, NO_PERMISSION_PROJECT);
    const job = await runNow(api, NO_PERMISSION_PROJECT);
    expect(job.state).toBe('failed');
    expect(job.result).toEqual({
      summary: 'dispatch-failed: permission missing',
      metrics: { reason: 'dispatch-failed' },
      acted: false,
    });
  } finally {
    await api.dispose();
  }
});

test('a pinned placement stays when the project goes to GitHub Actions, and picks the runner of its local-only jobs (#728)', async ({
  page,
  stack,
}, testInfo) => {
  const api = await apiClient(stack);
  try {
    await useApiKey(api, ACTIONS_PROJECT);
    const mac = await enrolRunner(api, ACTIONS_PROJECT);
    const other = await enrolRunner(api, ACTIONS_PROJECT);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openDispatch(page, ACTIONS_PROJECT);

    // The project's own placement: pinned to one of the account's two runners.
    const placement = page.getByTestId('runners-policy-project');
    await expect(placement.getByText(ru('runners.policy.note'))).toBeVisible();
    await placement.getByTestId('policy-mode-pinned').check();
    await placement.getByTestId('policy-pinned').selectOption(mac.id);
    await placement.getByTestId('runner-policy-save').click();
    await expect(placement.getByTestId('runner-policy-saved')).toHaveText(ru('runners.policy.saved'));

    // On Actions with the pin in place (the server keeps it across the switch: dispatch.spec, #728).
    await seedOnActions(testInfo.workerIndex, ACTIONS_PROJECT);
    const onActions = await openDispatch(page, ACTIONS_PROJECT);
    await expect(onActions.getByRole('radio', { name: ru('runners.dispatch.actions') })).toBeChecked();
    await expect(onActions.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('runners-policy-project').getByTestId('policy-mode-pinned')).toBeChecked();
    await expectAccessible(page, 'Settings › Runners, pinned placement on a GitHub Actions project');

    const dispatch = (await (
      await api.get(`/api/v1/projects/${ACTIONS_PROJECT}/dispatch`)
    ).json()) as ProjectDispatchDto;
    expect(dispatch.dispatch).toBe('actions');
    const policy = (await (await api.get(`/api/v1/projects/${ACTIONS_PROJECT}/runner-policy`)).json()) as {
      policy: unknown;
    };
    expect(policy.policy).toEqual({ mode: 'pinned', runner: mac.id });

    // A local-only job stays a pull job, and only the pinned runner takes it.
    const local = await api.post(`/api/v1/projects/${ACTIONS_PROJECT}/jobs`, {
      data: { kind: 'slot-dev', needsLocal: true },
    });
    expect(local.status(), await local.text()).toBe(201);
    expect(((await local.json()) as JobDto).dispatch).toBe('pull');
    expect(await claimStatus(api, other)).toBe(204);
    expect(await claimStatus(api, mac)).toBe(200);
  } finally {
    await api.dispose();
  }
});

test('the dispatch switch fits the phone', async ({ page, stack }, testInfo) => {
  const api = await apiClient(stack);
  try {
    await useApiKey(api, ACTIONS_PROJECT);
  } finally {
    await api.dispose();
  }
  await seedOnActions(testInfo.workerIndex, ACTIONS_PROJECT);
  await page.setViewportSize({ width: 375, height: 812 });
  const editor = await openDispatch(page, ACTIONS_PROJECT);
  await expect(editor.getByRole('radio', { name: ru('runners.dispatch.actions') })).toBeChecked();
  await expect(editor.getByTestId('project-dispatch-branch')).toHaveText(
    ru('runners.dispatch.branch', { branch: 'dev' }),
  );
  await editor.scrollIntoViewIfNeeded();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const box = await editor.getByTestId('project-dispatch-save').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expectAccessible(page, 'Settings › Runners on the phone, dispatch on GitHub Actions');
  await editor.screenshot({ path: testInfo.outputPath('dispatch-phone.png') });
});
