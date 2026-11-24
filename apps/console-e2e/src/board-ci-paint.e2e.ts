import type { Page } from '@playwright/test';
import type { SprintDto } from '@shared/contracts';
import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * The CI chip paints when the checks pass (#356). The mock GitHub's pull request #92 is running; the owner sees it on
 * the board, leaves and comes back (the board reloads whole), and by then it has passed. The sidebar is the wide
 * layout, so the phone project is skipped; the first test of each pair serves the changed answer, the second does the
 * same under reduced motion.
 */

const SPRINT = '**/api/v1/projects/team-console/sprint';
const PULL = 92;
const BOARD = '/p/team-console/board?tab=pr';

test.skip(({ isMobile }) => isMobile, 'the sidebar used to leave and return is the wide layout');

test.beforeAll(async ({ stack }) => {
  if (stack.isLocal) {
    await seed(stack, ['geeera/team-console']);
  }
});

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/v1/projects/team-console/sprint');
  const sprint = response.ok() ? ((await response.json()) as SprintDto) : null;
  test.skip(
    sprint?.openPullRequests.find((pull) => pull.number === PULL)?.ci !== 'pending',
    'needs the mock GitHub fixtures (GITHUB_MOCK=true) with #92 running',
  );
});

/** Answers the sprint read as the fixtures have it, with #92 passed from the second read on. */
async function passAfterFirstRead(page: Page): Promise<void> {
  let reads = 0;
  await page.route(SPRINT, async (route) => {
    const response = await route.fetch();
    const read = (await response.json()) as SprintDto;
    reads += 1;
    const body: SprintDto =
      reads > 1
        ? {
            ...read,
            openPullRequests: read.openPullRequests.map((pull) =>
              pull.number === PULL ? { ...pull, ci: 'success' } : pull,
            ),
          }
        : read;
    await route.fulfill({ response, json: body });
  });
}

/** Records whether any chip got the painting class, since it only lasts `--dur-slow`. */
async function watchPainting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = { painted: false };
    Object.assign(window, { __ciPainted: seen });
    // A chip created after a reload carries the class from its first render, so rows added count too.
    new MutationObserver(() => {
      if (document.querySelector('.sprint-ci-chip--painting') !== null) {
        seen.painted = true;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
}

const painted = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __ciPainted: { painted: boolean } }).__ciPainted.painted);

async function leaveAndReturn(page: Page): Promise<void> {
  await page.getByRole('button', { name: ru('shell.overview') }).click();
  await expect(page).toHaveURL(/\/overview/);
  await page.goBack();
}

test('a running check that passed is painted in when the board is opened again', async ({ page }) => {
  await passAfterFirstRead(page);
  await page.goto(BOARD);
  const chip = page.getByTestId('pulls').locator(`tc-list-row[data-number="${String(PULL)}"]`).getByTestId('ci');
  await expect(chip).toHaveAttribute('data-ci', 'pending');
  await watchPainting(page);

  await leaveAndReturn(page);

  await expect(chip).toHaveAttribute('data-ci', 'success');
  await expect(chip).toHaveText(ru('board.ci.state.success'));
  expect(await painted(page)).toBe(true);
  await expect(chip.locator('.sprint-ci__fill')).toHaveAttribute('aria-hidden', 'true');
  await expectAccessible(page, 'Board with a passed check');
});

test('under reduced motion the colour changes with no fill and no halo', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await passAfterFirstRead(page);
  await page.goto(BOARD);
  const chip = page.getByTestId('pulls').locator(`tc-list-row[data-number="${String(PULL)}"]`).getByTestId('ci');
  await expect(chip).toHaveAttribute('data-ci', 'pending');

  await leaveAndReturn(page);

  await expect(chip).toHaveAttribute('data-ci', 'success');
  await expect(chip.locator('.sprint-ci__fill')).toHaveCSS('animation-name', 'none');
  await expect(chip.locator('tc-chip')).toHaveCSS('animation-name', 'none');
});
