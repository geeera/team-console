import type { Page, Route } from '@playwright/test';
import { problemTypeOf, type JobListDto, type RunnerDto, type RunnerListDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { claimStatus, enrolRunner } from './support/runner';
import { apiClient, seed } from './support/stack';

/**
 * Run now and «Team jobs» on a project still on GitHub Issues (#775): the section shows on every project a runner may
 * serve, above the GitHub run log, which the «Runs» tile keeps reading (owner answer Q1). The owner's states run on
 * the real stack — no runner, an enrolled runner that has not polled yet (offline), then one that has (ready) — and
 * Run now from the header queues a job. A member's view, owner decision D3 and a refused kind need a second identity
 * or a kind the allow-list refuses, so those cases stub only the answer they are about.
 */

const SLUG = 'team-console';
const BOARD = `/p/${SLUG}/board?tab=runs`;
const JOBS = `**/api/v1/projects/${SLUG}/jobs?*`;

test.beforeEach(({ stack }) => {
  requireLocalStack(stack);
});

/** Rewrites the jobs list the Worker answered, as a member or an owner in a state the stack cannot reach. */
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

/** A subscription runner under «All account projects» that D3 keeps off this project. */
function d3Runner(enrolledByYou: boolean, enrolledByName: string | null = null): RunnerDto {
  return {
    id: '01M6YSNJ000000000000000R01',
    name: 'Mac',
    isolation: 'user',
    hosted: false,
    version: '0.3.0',
    pinnedVersion: null,
    host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
    capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] },
    projectScope: 'all',
    allowedProjects: [],
    servedProjects: [],
    enrolledAt: '2026-11-10T09:00:00.000Z',
    lastSeenAt: null,
    lastSeenCountry: null,
    online: false,
    suspect: null,
    revokedAt: null,
    belowMinimum: false,
    pause: null,
    enrolledByYou,
    enrolledByName,
    enroller: 'recorded',
  };
}

async function routeRunners(page: Page, runners: readonly RunnerDto[]): Promise<void> {
  await page.route('**/api/v1/accounts/*/runners', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as RunnerListDto;
    await route.fulfill({ response, json: { ...body, runners } });
  });
}

/**
 * What sticks out of the runs column (#829 CI): its labels are long and the kit button keeps one line by default, so
 * with wider type a block grew the column's `auto` track past the screen. Text must wrap inside the column.
 */
async function outsideRunsColumn(page: Page): Promise<string[]> {
  return page.getByTestId('runs').evaluate((column) => {
    const edge = column.getBoundingClientRect().right;
    return Array.from(column.querySelectorAll('*'))
      .filter((element) => element.closest('.tc-sr-only') === null)
      .filter((element) => element.getBoundingClientRect().right > edge + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''}`)
      .slice(0, 5);
  });
}

test('the owner: no runner, then an offline one, then a ready one, and Run now from the header queues a job', async ({
  page,
  stack,
}) => {
  await seed(stack, ['geeera/team-console']);
  const api = await apiClient(stack);
  try {
    await page.goto(BOARD);
    const runs = page.getByTestId('runs');

    // No runner serves the project: a block instead of the form, with the way out; the GitHub log stays below.
    const none = runs.getByTestId('jobs-none');
    await expect(none).toHaveAttribute('data-none', 'owner');
    await expect(none.getByRole('heading', { level: 4 })).toHaveText(ru('jobs.none.title'));
    await expect(none.getByTestId('jobs-none-runners')).toHaveAttribute('href', '/settings/runners');
    await expect(runs.getByTestId('run-now')).toHaveCount(0);
    const log = runs.getByTestId('github-run-log');
    await expect(log.getByRole('heading', { level: 3 })).toHaveText(ru('board.runs.githubLog'));
    await expect(log).toContainText(ru('board.runs.githubLogHint'));
    // Q1: the «Runs» tile keeps reading the run log on GitHub.
    await expect(page.getByTestId('team-stat')).toHaveAttribute('data-team', /.+/);
    await expect(page.getByTestId('team-stat')).not.toHaveAttribute('data-jobs', /.+/);
    await expectAccessible(page, 'Board, GitHub tracker, no runner (owner)');

    // The header's Run lands on the block's heading: there is no form to land on.
    await page.getByTestId('board-run-now').click();
    await expect(none.getByRole('heading', { level: 4 })).toBeFocused();

    // Enrolled but never seen: offline, and the form is there with the ochre line.
    const runner = await enrolRunner(api, SLUG);
    await page.reload();
    const availability = runs.getByTestId('jobs-availability');
    await expect(availability).toHaveAttribute('data-availability', 'offline');
    await expect(availability).toContainText(ru('jobs.availability.offlineLead'));
    await expect(availability.getByTestId('jobs-availability-runners')).toHaveAttribute('href', '/settings/runners');
    await expect(runs.getByTestId('run-now-submit')).toBeEnabled();

    // The runner polls once (nothing to claim yet): ready, no line.
    expect(await claimStatus(api, runner)).toBe(204);
    await page.reload();
    await expect(availability).toHaveAttribute('data-availability', 'ready');
    await expect(availability).toHaveText('');

    await page.getByTestId('board-run-now').click();
    const kind = runs.getByRole('combobox', { name: ru('jobs.runNow.kind') });
    await expect(kind).toBeFocused();
    await expect(kind).toHaveAccessibleDescription(ru('jobs.runNow.hint'));
    await kind.selectOption('digest');
    await runs.getByTestId('run-now-submit').click();
    await expect(runs.getByTestId('run-now-outcome')).toHaveText(
      ru('jobs.runNow.queued', { kind: ru('jobs.kind.digest') }),
    );
    const card = runs.getByTestId('jobs-current').getByTestId('job-card');
    await expect(card).toHaveAttribute('data-kind', 'digest');
    await expect(card).toHaveAttribute('data-state', 'queued');
    await expectAccessible(page, 'Board, GitHub tracker, a queued job (owner)');
  } finally {
    await api.dispose();
  }
});

test('a member gets no form and no header Run, only the line about the account owner; with no runner, the generic block', async ({
  page,
  stack,
}) => {
  await seed(stack, ['geeera/team-console']);
  let availability: JobListDto['runnerAvailability'] = 'ready';
  await routeJobs(page, (list) => ({ jobs: list.jobs, nextCursor: list.nextCursor, runnerAvailability: availability, canRunNow: false }));
  await page.goto(BOARD);
  const runs = page.getByTestId('runs');
  await expect(runs.getByTestId('jobs-member-line')).toHaveText(ru('jobs.member.line'));
  await expect(runs.getByTestId('run-now')).toHaveCount(0);
  await expect(page.getByTestId('board-run-now')).toHaveCount(0);
  await expect(runs.getByTestId('jobs-empty')).toContainText(ru('jobs.view.emptyHintMember'));
  await expectAccessible(page, 'Board, GitHub tracker, member');

  availability = 'none';
  await page.reload();
  const none = runs.getByTestId('jobs-none');
  await expect(none).toHaveAttribute('data-none', 'member');
  await expect(none.getByTestId('jobs-none-body')).toHaveText(ru('jobs.none.member'));
  await expect(none.getByRole('link')).toHaveCount(0);
});

// #775 (migration 0038): with display names the copy names the people; each name is isolated and plain text.
test('with display names, a member hears who the owners are and the D3 owner hears whose runner it is', async ({
  page,
  stack,
}) => {
  await seed(stack, ['geeera/team-console']);
  let list: (list: JobListDto) => JobListDto = (answer) => ({
    jobs: answer.jobs,
    nextCursor: answer.nextCursor,
    runnerAvailability: 'ready',
    canRunNow: false,
    accountOwnerNames: ['Анна', 'Борис'],
  });
  await routeJobs(page, (answer) => list(answer));
  await page.goto(BOARD);
  const runs = page.getByTestId('runs');
  await expect(runs.getByTestId('jobs-member-line')).toHaveText(
    ru('jobs.member.lineNamed', { owners: '\u2068Анна\u2069, \u2068Борис\u2069' }),
  );
  await expectAccessible(page, 'Board, GitHub tracker, member, named owners');

  list = (answer) => ({ jobs: answer.jobs, nextCursor: answer.nextCursor, runnerAvailability: 'none', canRunNow: true, runnerUnavailableReason: 'other-owner-subscription' });
  await routeRunners(page, [d3Runner(false, 'Анна')]);
  await page.reload();
  await expect(runs.getByTestId('jobs-none-body')).toHaveText(
    ru('jobs.none.d3Named', { runner: '\u2068Mac\u2069', owner: '\u2068Анна\u2069', project: '\u2068team-console\u2069' }),
  );
});

test('D3: another owner’s subscription runner and the owner’s own one each get their copy, a way out and «Why»', async ({
  page,
  stack,
}) => {
  await seed(stack, ['geeera/team-console']);
  await routeJobs(page, (list) => ({ ...list, runnerAvailability: 'none', canRunNow: true, runnerUnavailableReason: 'other-owner-subscription' }));
  await routeRunners(page, [d3Runner(false)]);
  await page.goto(BOARD);
  const runs = page.getByTestId('runs');
  const none = runs.getByTestId('jobs-none');
  await expect(none).toHaveAttribute('data-none', 'd3');
  await expect(none.getByRole('heading', { level: 4 })).toHaveText(ru('jobs.none.d3Title'));
  await expect(none.getByTestId('jobs-none-body')).toHaveText(
    ru('jobs.none.d3', { runner: '⁨Mac⁩', project: '⁨team-console⁩' }),
  );
  await expect(none.getByTestId('jobs-none-connect')).toHaveText(ru('jobs.none.d3Connect'));
  await none.getByText(ru('jobs.none.why')).click();
  await expect(none.getByText(ru('jobs.none.whyBody'))).toBeVisible();
  await expect(runs.getByTestId('run-now')).toHaveCount(0);
  await expectAccessible(page, 'Board, GitHub tracker, D3 another owner’s runner');

  await page.unroute('**/api/v1/accounts/*/runners');
  await routeRunners(page, [d3Runner(true)]);
  await page.reload();
  await expect(none).toHaveAttribute('data-none', 'd3-mine');
  await expect(none.getByRole('heading', { level: 4 })).toHaveText(ru('jobs.none.d3MineTitle'));
  await expect(none.getByTestId('jobs-none-runner')).toHaveText(ru('jobs.none.d3MineOpen', { runner: '⁨Mac⁩' }));
});

test('with much wider type the no-runner blocks wrap inside the runs column, beside the issues on a 1280 px screen', async ({
  page,
  stack,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the runs column sits beside the issues on a wide screen only');
  await seed(stack, ['geeera/team-console']);
  await page.setViewportSize({ width: 1280, height: 800 });
  const none = page.getByTestId('runs').getByTestId('jobs-none');
  const wideType = { content: 'html { letter-spacing: 0.2em; }' };

  await page.goto(BOARD);
  await expect(none).toHaveAttribute('data-none', 'owner');
  await page.addStyleTag(wideType);
  expect(await outsideRunsColumn(page), 'the owner’s block').toEqual([]);

  await routeJobs(page, (list) => ({ ...list, runnerAvailability: 'none', canRunNow: true, runnerUnavailableReason: 'other-owner-subscription' }));
  for (const enrolledByYou of [false, true]) {
    await page.unroute('**/api/v1/accounts/*/runners');
    await routeRunners(page, [d3Runner(enrolledByYou)]);
    await page.reload();
    await expect(none).toHaveAttribute('data-none', enrolledByYou ? 'd3-mine' : 'd3');
    await page.addStyleTag(wideType);
    expect(await outsideRunsColumn(page), `the ${enrolledByYou ? 'd3-mine' : 'd3'} block`).toEqual([]);
  }
  await expectAccessible(page, 'Board, the D3 block with wider type');
});

test('a kind the server refuses says so in clay and queues nothing', async ({ page, stack }) => {
  await seed(stack, ['geeera/team-console']);
  await page.route(`**/api/v1/projects/${SLUG}/jobs`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      json: { type: problemTypeOf('tracker-not-cut-over'), title: 'Conflict', status: 409 },
    });
  });
  await routeJobs(page, (list) => ({ jobs: list.jobs, nextCursor: list.nextCursor, runnerAvailability: 'ready', canRunNow: true }));
  await page.goto(BOARD);
  const runs = page.getByTestId('runs');
  await runs.getByTestId('run-now-submit').click();
  await expect(runs.getByTestId('run-now-error')).toHaveText(ru('jobs.err.kindNotAllowed'));
  await expect(runs.getByTestId('jobs-current')).toHaveCount(0);
  await expectAccessible(page, 'Board, GitHub tracker, a refused kind');
});
