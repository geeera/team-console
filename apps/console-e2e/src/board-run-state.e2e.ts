import type { Locator, Page } from '@playwright/test';
import type { SprintDto } from '@shared/contracts';
import { expect, expectAccessible, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { seed, type Stack } from './support/stack';

/**
 * The team's run state on the board (#132): the "Run log" tile says running / paused / failing / unknown as the
 * plugin's `runstate` reads the run log, and the last five runs are listed with slot, time and state, with a link to
 * the run-log issue. A team entry edited after the fact shows as unknown, never as failed; an outsider's entry is
 * ignored. The run log (#22) is seeded on the fake GitHub with times relative to now, so the running run is fresh.
 */

const SPRINT = '/api/v1/projects/team-console/sprint';
const REPO = 'geeera/team-console';
const LOG = 22;
const MINUTE = 60_000;

interface Entry {
  readonly run: string;
  readonly slot: string;
  readonly state: string;
  readonly minutesAgo: number;
  readonly editedMinutesAgo?: number;
  readonly author?: string;
}

/** Newest first on the board: dev running, pm finished, dev edited (unknown), qa finished, dev failed. */
const ENTRIES: readonly Entry[] = [
  { run: 'e2e-r1', slot: 'slot-pm', state: 'started', minutesAgo: 300 },
  { run: 'e2e-r1', slot: 'slot-pm', state: 'finished', minutesAgo: 290 },
  { run: 'e2e-r2', slot: 'slot-dev', state: 'started', minutesAgo: 240 },
  { run: 'e2e-r2', slot: 'slot-dev', state: 'failed', minutesAgo: 220 },
  { run: 'e2e-r3', slot: 'slot-qa', state: 'started', minutesAgo: 180 },
  { run: 'e2e-r3', slot: 'slot-qa', state: 'finished', minutesAgo: 170 },
  { run: 'e2e-r4', slot: 'slot-dev', state: 'started', minutesAgo: 120 },
  { run: 'e2e-r4', slot: 'slot-dev', state: 'failed', minutesAgo: 110, editedMinutesAgo: 60 },
  { run: 'e2e-r5', slot: 'slot-pm', state: 'started', minutesAgo: 60 },
  { run: 'e2e-r5', slot: 'slot-pm', state: 'finished', minutesAgo: 50 },
  { run: 'e2e-r6', slot: 'slot-dev', state: 'started', minutesAgo: 20 },
  { run: 'e2e-r6', slot: 'slot-dev', state: 'failed', minutesAgo: 10, author: 'outsider' },
];

const EXPECTED = [
  { slot: 'dev', state: 'running' },
  { slot: 'pm', state: 'finished' },
  { slot: 'dev', state: 'unknown' },
  { slot: 'qa', state: 'finished' },
  { slot: 'dev', state: 'failed' },
] as const;

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

/** Serves the run log thread from the fake GitHub, opened by `logAuthor`, reset to `entries`. */
async function seedRunLog(stack: Stack, entries: readonly Entry[], logAuthor = 'geeera'): Promise<void> {
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: LOG,
    title: 'Team run log',
    author: logAuthor,
    labels: ['team:run-log'],
    repoOwner: { login: 'geeera', id: 100001 },
  });
  const now = Date.now();
  for (const entry of entries) {
    await fakePost(stack, '/_fake/comment', {
      repo: REPO,
      number: LOG,
      body: `<!-- pt-run id=${entry.run} slot=${entry.slot} state=${entry.state} -->\n**${entry.slot}** ${entry.state}`,
      author: entry.author ?? 'geeera',
      createdAt: now - entry.minutesAgo * MINUTE,
      ...(entry.editedMinutesAgo === undefined ? {} : { updatedAt: now - entry.editedMinutesAgo * MINUTE }),
    });
  }
}

const runsOf = (page: Page): Locator => page.getByTestId('runs').getByTestId('run');

test.beforeAll(async ({ stack }) => {
  test.skip(
    stack.fakeURL === null,
    'needs the fake GitHub (a local stack, or FAKE_GITHUB_URL beside a mock target)',
  );
  // A running mock target (BASE_URL) already holds the fixture project; a local stack starts empty.
  if (stack.isLocal) {
    await seed(stack, [REPO]);
  }
  await seedRunLog(stack, ENTRIES);
});

// The fake GitHub outlives `seed`: leave the run log empty, as the next spec of this worker would find it.
test.afterAll(async ({ stack }) => {
  if (stack.fakeURL !== null) {
    await seedRunLog(stack, []);
  }
});

test('the sprint read model carries the run state and the last five runs', async ({ request }) => {
  // A running target may still hold the run state it read before the seed: the read cache keeps it 30 s.
  test.setTimeout(60_000);
  const recentOf = async (): Promise<unknown> => {
    const sprint = (await (await request.get(SPRINT)).json()) as SprintDto;
    return sprint.team.recentRuns.map(({ slot, state }) => ({ slot, state }));
  };
  await expect.poll(recentOf, { timeout: 45_000, intervals: [1_000, 5_000] }).toEqual(EXPECTED);

  const sprint = (await (await request.get(SPRINT)).json()) as SprintDto;
  expect(sprint.team.state).toBe('running');
  expect(sprint.team.runLogUrl).toBe(`https://github.com/${REPO}/issues/${LOG}`);
  expect(sprint.team.recentRuns.map(({ slot, state }) => ({ slot, state }))).toEqual(EXPECTED);
});

test('the Run log tile and the last runs show icon and words; an edited run is unknown, not failed', async ({
  page,
}) => {
  await page.goto('/p/team-console/board');
  await expect(page.getByTestId('loading')).toHaveCount(0);

  const tile = page.getByTestId('team-stat');
  await expect(tile).toHaveAttribute('data-team', 'running');
  await expect(tile.locator('dt')).toHaveText(ru('board.stat.runs'));
  await expect(tile.locator('dd')).toHaveText(ru('board.team.running'));
  await expect(tile.locator('dd tc-icon')).toHaveAttribute('aria-hidden', 'true');

  const lane = page.getByTestId('runs');
  await lane.scrollIntoViewIfNeeded();
  await expect(lane.getByRole('heading', { level: 2 })).toContainText(ru('board.runs.title'));
  await expect(lane.getByRole('list', { name: ru('board.runs.title') })).toBeVisible();
  await expect(runsOf(page)).toHaveCount(EXPECTED.length);
  for (const [index, { slot, state }] of EXPECTED.entries()) {
    const row = runsOf(page).nth(index);
    await expect(row).toHaveAttribute('data-state', state);
    await expect(row.locator('[tc-row-title]')).toHaveText(ru(`commands.slot.${slot}`));
    await expect(row.getByTestId('run-state')).toHaveText(ru(`board.run.state.${state}`));
    await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  }
  // The edited "failed" and the outsider's "failed" never read as failed: only the one honest failure does.
  await expect(page.locator('[data-testid="run"][data-state="failed"]')).toHaveCount(1);

  const link = lane.getByRole('link', { name: new RegExp(ru('board.runs.log')) });
  await expect(link).toHaveAttribute('href', `https://github.com/${REPO}/issues/${LOG}`);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAccessibleName(`${ru('board.runs.log')} ${ru('board.opensGitHub')}`);

  await expectAccessible(page, 'Project board with the run state');
});

test('the run state follows the language', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('switch-lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.goto('/p/team-console/board');

  await expect(page.getByTestId('team-stat').locator('dt')).toHaveText(en('board.stat.runs'));
  await expect(page.getByTestId('team-stat').locator('dd')).toHaveText(en('board.team.running'));
  await expect(runsOf(page).first().getByTestId('run-state')).toHaveText(en('board.run.state.running'));
  await expect(runsOf(page).nth(2).getByTestId('run-state')).toHaveText(en('board.run.state.unknown'));
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the run state passes axe', async ({ page }) => {
    await page.goto('/p/team-console/board');
    await expect(page.getByTestId('team-stat')).toHaveAttribute('data-team', 'running');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await page.getByTestId('runs').scrollIntoViewIfNeeded();
    await expectAccessible(page, 'Project board with the run state (dark)');
  });
});

// #201: a run log the board cannot trust (opened by someone outside the team; a refused read or the budget end the
// same way) is "unavailable" with a question mark, never "no runs yet" with a check.
test.describe('a run log opened by someone outside the team', () => {
  test.beforeAll(async ({ stack }) => {
    await seedRunLog(stack, ENTRIES, 'outsider');
    if (stack.isLocal) {
      // A fresh isolate: no run state cached from the tests above.
      await seed(stack, [REPO]);
    }
  });

  test('the tile is unknown and the lane says the run log is unavailable', async ({ page, request }) => {
    // A running target may still hold the run state it read before the seed: the read cache keeps it 30 s.
    test.setTimeout(60_000);
    const stateOf = async (): Promise<string> =>
      ((await (await request.get(SPRINT)).json()) as SprintDto).team.state;
    await expect.poll(stateOf, { timeout: 45_000, intervals: [1_000, 5_000] }).toBe('unknown');

    await page.goto('/p/team-console/board');
    await expect(page.getByTestId('team-stat')).toHaveAttribute('data-team', 'unknown');
    await expect(page.getByTestId('team-stat').locator('dd')).toHaveText(ru('board.team.unknown'));

    const lane = page.getByTestId('runs');
    await lane.scrollIntoViewIfNeeded();
    const block = lane.getByTestId('runs-unavailable');
    await expect(block).toContainText(ru('board.runs.unavailable'));
    await expect(block).toContainText(ru('board.runs.unavailableHint'));
    await expect(block.locator('tc-icon')).toHaveAttribute('aria-hidden', 'true');
    await expect(lane.getByTestId('runs-empty')).toHaveCount(0);
    await expect(lane.getByTestId('run')).toHaveCount(0);
    await expect(lane.getByRole('link')).toHaveCount(0);

    await expectAccessible(page, 'Project board with the run log unavailable');
  });
});
