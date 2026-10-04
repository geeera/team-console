import type { Locator, Page } from '@playwright/test';
import type { SprintDto } from '@shared/contracts';
import { expect, expectAccessible, test } from './support/fixtures';
import { en, ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * CI on the board (#131): every open pull request shows its head commit's checks as an icon and words, and the "CI"
 * tile names the most urgent state, at 390 px and on the desktop. The mock GitHub's geeera/team-console has one pull
 * request per state: #92 running, #91 without checks, #45 passed, #40 a passed and a failed check.
 */

const SPRINT = '/api/v1/projects/team-console/sprint';
const EXPECTED = [
  { number: 92, ci: 'pending' },
  { number: 91, ci: 'none' },
  { number: 45, ci: 'success' },
  { number: 40, ci: 'failure' },
] as const;

const rowOf = (page: Page, number: number): Locator =>
  page.getByTestId('pulls').locator(`tc-list-row[data-number="${number}"]`);

test.beforeAll(async ({ stack }) => {
  // A running mock target (BASE_URL) already holds the fixture project; a local stack starts empty.
  if (stack.isLocal) {
    await seed(stack, ['geeera/team-console']);
  }
});

test.beforeEach(async ({ request }) => {
  const response = await request.get(SPRINT);
  const sprint = response.ok() ? ((await response.json()) as SprintDto) : null;
  test.skip(
    !sprint?.openPullRequests.some((pull) => pull.number === 92),
    'needs the mock GitHub fixtures (GITHUB_MOCK=true)',
  );
});

test('the sprint read model carries a CI state per open pull request', async ({ request }) => {
  const sprint = (await (await request.get(SPRINT)).json()) as SprintDto;
  expect(sprint.openPullRequests.map(({ number, ci }) => ({ number, ci }))).toEqual(EXPECTED);
});

test('each open pull request shows its CI with an icon and words, and the CI tile the failing one', async ({
  page,
}) => {
  await page.goto('/p/team-console/board');
  await expect(page.getByTestId('loading')).toHaveCount(0);

  for (const { number, ci } of EXPECTED) {
    const row = rowOf(page, number);
    const chip = row.getByTestId('ci');
    await expect(chip).toHaveAttribute('data-ci', ci);
    await expect(chip).toHaveText(ru(`board.ci.state.${ci}`));
    await expect(chip.locator('tc-icon')).toHaveAttribute('aria-hidden', 'true');
    // The words are part of the row link's name, so a screen reader hears the state with the title.
    await expect(row.getByRole('link')).toHaveAccessibleName(new RegExp(ru(`board.ci.state.${ci}`)));
  }

  const tile = page.getByTestId('ci-stat');
  await expect(tile).toHaveAttribute('data-ci', 'failure');
  await expect(tile.locator('dt')).toHaveText(ru('board.stat.ci'));
  await expect(tile.locator('dd')).toHaveText(ru('board.ci.summary.failure', { n: 1 }));
  await expect(tile.locator('dd tc-icon')).toHaveAttribute('aria-hidden', 'true');

  await rowOf(page, 40).scrollIntoViewIfNeeded();
  await expectAccessible(page, 'Project board with CI states');
});

test('the CI copy follows the language', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('switch-lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // A full load: the choice is persisted, as after a PWA restart.
  await page.goto('/p/team-console/board');

  await expect(rowOf(page, 40).getByTestId('ci')).toHaveText(en('board.ci.state.failure'));
  await expect(page.getByTestId('ci-stat').locator('dd')).toHaveText(
    en('board.ci.summary.failure', { n: 1 }),
  );
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the CI chips and tile pass axe', async ({ page }) => {
    await page.goto('/p/team-console/board');
    await expect(page.getByTestId('ci-stat')).toHaveAttribute('data-ci', 'failure');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await rowOf(page, 40).scrollIntoViewIfNeeded();
    await expectAccessible(page, 'Project board with CI states (dark)');
  });
});
