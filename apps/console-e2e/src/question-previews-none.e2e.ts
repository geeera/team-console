import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { clearFakePulls, fakePost, seed } from './support/stack';

/**
 * The design question card with no screens (#852, state of #276 §3): design #90006 has no folder under docs/design,
 * so its card shows a note instead of previews. With no pull request the note stands alone; with the design's pull
 * request open, the note says to look at the PR and links to it.
 */
test.describe.configure({ mode: 'serial' });

const ISSUE = 90006;
const REPO = 'geeera/team-console';
const PULL_URL = `https://github.com/${REPO}/pull/177`;

const card = (page: Page): Locator => page.locator(`li[data-number="${ISSUE}"]`);
const note = (page: Page): Locator => card(page).getByTestId('question-previews-none');

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, [REPO]);
});

test.afterAll(async ({ stack }) => {
  if (stack.fakeURL !== null) {
    await clearFakePulls(stack, REPO);
  }
});

test('a design with no screens and no pull request shows the note alone', async ({ page }) => {
  await page.goto('/needs-you');
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText(ru('questions.previews.noneNoPr'));
  await expect(note(page)).not.toContainText(ru('questions.previews.none'));
  await expect(card(page).getByTestId('question-previews-pr')).toHaveCount(0);
  await expect(card(page).getByTestId('question-preview')).toHaveCount(0);
  await expectAccessible(page, 'Design card with no screens and no pull request');
});

test('a design with no screens links its pull request', async ({ page, stack }) => {
  await fakePost(stack, '/_fake/pulls', {
    repo: REPO,
    pulls: [
      {
        number: 177,
        title: `design(#${ISSUE}): onboarding`,
        body: `Closes #${ISSUE}`,
        html_url: PULL_URL,
        draft: false,
        author_association: 'OWNER',
        user: { login: 'geeera', type: 'User' },
        state: 'open',
        head: { sha: 'c'.repeat(40), ref: `design/${ISSUE}-onboarding`, repo: { full_name: REPO } },
      },
    ],
  });
  // A reset clears the Worker's 60 s read cache, as a minute would; the fake keeps the pull request.
  await seed(stack, [REPO]);
  await page.goto('/needs-you');
  await expect(note(page)).toContainText(ru('questions.previews.none'));
  const link = card(page).getByTestId('question-previews-pr');
  await expect(link).toHaveAttribute('href', PULL_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toContainText(ru('questions.previews.openPr'));
  await expectAccessible(page, 'Design card with no screens and its pull request');
});
