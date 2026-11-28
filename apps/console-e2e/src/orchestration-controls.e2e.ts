import type { Page, Route } from '@playwright/test';
import type { ClaimResponse, JobListDto, OrchestrationDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { asRunner, claimStatus, enrolRunner } from './support/runner';
import { apiClient, seed } from './support/stack';

/**
 * The team's Start and Stop beside Run now (#1042, ADR 0010) on the real local stack: the owner presses Start, the
 * Worker's `POST …/orchestration/start` takes the run lock and queues a real `orchestrate` step, which «Team jobs»
 * shows; a runner (its own Ed25519 key) claims it; Stop asks first, then hard-cancels it and the card ends
 * `cancelled`. A member's view needs a second identity, so that case alone stubs the jobs answer, as Run now's
 * member case does. Runs at 390 px (iphone) and 1440 px (desktop), light and dark.
 */

const SLUG = 'team-console';
const BOARD = `/p/${SLUG}/board?tab=runs`;
const JOBS = `**/api/v1/projects/${SLUG}/jobs?*`;
const ORCHESTRATION = `/api/v1/projects/${SLUG}/orchestration`;

test.beforeEach(({ stack }) => {
  requireLocalStack(stack);
});

/** Rewrites the jobs list the Worker answered, as a member would read it. */
async function routeJobs(page: Page, change: (list: JobListDto) => JobListDto): Promise<void> {
  await page.route(JOBS, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response, json: change((await response.json()) as JobListDto) });
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the owner starts the team, a real step job appears, a runner claims it, and Stop cancels it', async ({
      page,
      stack,
    }) => {
      await seed(stack, ['geeera/team-console']);
      const api = await apiClient(stack);
      try {
        const runner = await enrolRunner(api, SLUG);
        // One poll with nothing queued makes the runner ready, so the outcome says «queued», not «waits».
        expect(await claimStatus(api, runner)).toBe(204);

        await page.goto(BOARD);
        await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);
        const runs = page.getByTestId('runs');
        const controls = runs.getByTestId('orchestration');
        await expect(controls).toHaveAttribute('data-state', 'idle');
        await expect(controls.getByRole('heading', { level: 4 })).toHaveText(ru('orchestration.title'));
        await expect(controls.getByTestId('orchestration-state')).toHaveText(ru('orchestration.state.idle'));
        // Beside Run now: the controls come right after its form.
        await expect(runs.locator('tc-run-now + tc-orchestration-controls')).toHaveCount(1);
        const start = controls.getByRole('button', { name: ru('orchestration.start') });
        await expect(start).toBeEnabled();
        await expect(runs.getByTestId('jobs-empty')).toBeVisible();
        await expectAccessible(page, `Board, team idle, Start (${colorScheme})`);

        // 1. Start reaches the Worker's real route (no stub on it) and queues an `orchestrate` step.
        const startAnswer = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().endsWith(`${ORCHESTRATION}/start`),
        );
        await start.click();
        const started = await startAnswer;
        expect(started.status()).toBe(201);
        const run = (await started.json()) as OrchestrationDto;
        expect(run.state).toBe('running');
        expect(run.liveStepId).not.toBeNull();
        await expect(controls.getByTestId('orchestration-outcome')).toHaveText(
          ru('orchestration.outcome.started'),
        );
        const stop = controls.getByRole('button', { name: ru('orchestration.stop') });
        // The same button changed: focus stays on it.
        await expect(stop).toBeFocused();
        await expect(controls).toHaveAttribute('data-state', 'running');
        await expect(controls.getByTestId('orchestration-state')).toHaveText(
          ru('orchestration.state.running', { steps: '1', max: '20' }),
        );
        const card = runs.getByTestId('jobs-current').getByTestId('job-card');
        await expect(card).toHaveAttribute('data-kind', 'orchestrate');
        await expect(card).toHaveAttribute('data-state', 'queued');
        await expect(card).toContainText(ru('jobs.kind.orchestrate'));
        await expectAccessible(page, `Board, team running, a queued step (${colorScheme})`);

        // 2. The runner claims that very step: it runs on the runner.
        const claim = (await asRunner(api, runner, '/jobs/claim', {})) as ClaimResponse;
        expect(claim.job.kind).toBe('orchestrate');
        expect(claim.job.id).toBe(run.liveStepId);
        await asRunner(api, runner, `/jobs/${claim.job.id}/events`, {
          events: [{ level: 'info', kind: 'started', payload: { skill: 'orchestrate' } }],
        });
        await runs.getByTestId('jobs-refresh').click();
        await expect(card).toHaveAttribute('data-state', 'running');

        // 3. Stop asks first; Cancel keeps the run.
        await stop.click();
        const dialog = page.getByRole('alertdialog', { name: ru('orchestration.confirm.title') });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(ru('orchestration.confirm.message'));
        await expectAccessible(page, `Board, Stop the team? (${colorScheme})`);
        await dialog.getByRole('button', { name: ru('orchestration.confirm.cancel') }).click();
        await expect(dialog).toHaveCount(0);
        await expect(stop).toBeFocused();
        await expect(card).toHaveAttribute('data-state', 'running');

        // 4. Stop confirmed: the Worker cancels the step; the card moves to the recent list as `cancelled`.
        const stopAnswer = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().endsWith(`${ORCHESTRATION}/stop`),
        );
        await stop.click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', { name: ru('orchestration.confirm.ok') })
          .click();
        expect((await stopAnswer).status()).toBe(200);
        await expect(controls.getByTestId('orchestration-outcome')).toHaveText(
          ru('orchestration.outcome.stopped'),
        );
        await expect(controls).toHaveAttribute('data-state', 'idle');
        await expect(controls.getByRole('button', { name: ru('orchestration.start') })).toBeEnabled();
        const ended = runs.getByTestId('jobs-recent').getByTestId('job-card');
        await expect(ended).toHaveAttribute('data-kind', 'orchestrate');
        await expect(ended).toHaveAttribute('data-state', 'cancelled');
        await expect(ended.getByTestId('job-state')).toHaveText(ru('jobs.state.cancelled'));
        await expect(runs.getByTestId('jobs-current')).toHaveCount(0);
        await expectAccessible(page, `Board, team stopped, a cancelled step (${colorScheme})`);

        // The Worker agrees: no run, and a second Stop is the idle refusal.
        const after = await api.get(ORCHESTRATION);
        expect(((await after.json()) as OrchestrationDto).state).toBe('idle');
        const again = await api.post(`${ORCHESTRATION}/stop`, { data: {} });
        expect(again.status()).toBe(409);
      } finally {
        await api.dispose();
      }
    });

    test('with no runner, the owner sees Start held back with its reason under the «no runner» block', async ({
      page,
      stack,
    }) => {
      await seed(stack, ['geeera/team-console']);
      await page.goto(BOARD);
      const runs = page.getByTestId('runs');
      await expect(runs.getByTestId('jobs-none')).toHaveAttribute('data-none', 'owner');
      const start = runs
        .getByTestId('orchestration')
        .getByRole('button', { name: ru('orchestration.start') });
      await expect(start).toHaveAttribute('aria-disabled', 'true');
      await expect(start).toHaveAccessibleDescription(ru('orchestration.reason.noRunner'));
      await expect(runs.getByTestId('orchestration-reason')).toBeVisible();
      // Off, not disabled: it stays focusable with its reason; a press from the keyboard does nothing.
      await start.focus();
      await page.keyboard.press('Enter');
      await expect(runs.getByTestId('orchestration-outcome')).toHaveText('');
      await expect(runs.getByTestId('jobs-current')).toHaveCount(0);
      await expectAccessible(page, `Board, no runner, Start held back (${colorScheme})`);
    });

    test('a member sees neither Start nor Stop', async ({ page, stack }) => {
      await seed(stack, ['geeera/team-console']);
      await routeJobs(page, (list) => ({
        jobs: list.jobs,
        nextCursor: list.nextCursor,
        runnerAvailability: 'ready',
        canRunNow: false,
      }));
      await page.goto(BOARD);
      const runs = page.getByTestId('runs');
      await expect(runs.getByTestId('jobs-member-line')).toHaveText(ru('jobs.member.line'));
      await expect(runs.getByTestId('orchestration')).toHaveCount(0);
      await expect(page.getByRole('button', { name: ru('orchestration.start') })).toHaveCount(0);
      await expect(page.getByRole('button', { name: ru('orchestration.stop') })).toHaveCount(0);
      await expectAccessible(page, `Board, member, no team controls (${colorScheme})`);
    });
  });
}
