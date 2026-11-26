import type { NeedsYouDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * The «Ждут вас» row of a project whose inbox could not be read (#214). The problem is real, not mocked: the fake
 * GitHub's `geeera/mock-rate-limited` repository answers every read with a 403 rate limit, so the api reports
 * `problem` for it. It is the only project, so no question exists and the row has to stand in for the empty state.
 */

const SLUG = 'mock-rate-limited';
const NAME = 'mock-rate-limited';

// The phone width of the demo, whichever project runs the spec.
test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, [`geeera/${SLUG}`]);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('a project whose inbox could not be read is a row that says why, links to its settings and replaces the empty state', async ({
      page,
      request,
    }) => {
      const needsYou = (await (await request.get('/api/v1/needs-you')).json()) as NeedsYouDto;
      expect(needsYou.items, 'the only project has no questions').toHaveLength(0);
      const project = needsYou.projects.find((entry) => entry.slug === SLUG);
      expect(project?.problem, 'the fake GitHub really made the read fail').not.toBeNull();

      await page.goto('/needs-you');
      await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);

      const row = page.getByTestId('project-problem');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-project', SLUG);
      // Names the project and the reason in plain words.
      await expect(row).toContainText(
        ru('questions.projectProblem', { name: NAME, reason: ru('questions.problem.github-rate-limit') }),
      );
      await expect(row).toHaveAttribute('href', `/settings/projects/${SLUG}`);
      expect(meetsMinTap((await row.boundingBox())?.height)).toBe(true);

      // Counted in the summary line: no questions, one project needing the owner.
      await expect(page.getByTestId('lead')).toHaveText(ru('needsYou.leadNoQuestions', { k: 1 }));
      // The row stands in for the clear desk.
      await expect(page.getByTestId('empty')).toHaveCount(0);
      await expect(page.getByTestId('desk-stamp')).toHaveCount(0);

      await expectAccessible(page, `needs you with an unreadable project (${colorScheme})`);

      await row.click();
      await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}$`));
    });
  });
}
