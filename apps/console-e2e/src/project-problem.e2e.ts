import { problemTypeOf, type NeedsYouDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';
import { meetsMinTap } from './support/tap-target';

/**
 * The «Ждут вас» row of a project whose inbox could not be read (#214). The stack cannot cause the problem for real:
 * the api's mock GitHub is static, and a repository without the app installed is refused when the project is added,
 * so a registered project never fails to read afterwards. The real needs-you answer is therefore fetched and given
 * the one thing the stack cannot produce, a `problem` on the only project (and no questions): everything the owner
 * sees (row, link, summary, empty state, axe) is the real console on top of it.
 */

const SLUG = 'team-console';

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
    }) => {
      await page.route('**/api/v1/needs-you', async (route) => {
        const real = (await (await route.fetch()).json()) as NeedsYouDto;
        const unreadable: NeedsYouDto = {
          items: [],
          omittedProjects: [],
          projects: real.projects.map((project) => ({
            ...project,
            problem: {
              type: problemTypeOf('github-app-not-installed'),
              title: 'The console app is not installed on the repository',
              status: 409,
            },
          })),
        };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(unreadable) });
      });

      await page.goto('/needs-you');
      await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);

      const row = page.getByTestId('project-problem');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-project', SLUG);
      // Names the project and the reason in plain words.
      await expect(row).toContainText(
        ru('questions.projectProblem', {
          name: SLUG,
          reason: ru('questions.problem.github-app-not-installed'),
        }),
      );
      await expect(row).toHaveAttribute('href', `/settings/projects/${SLUG}`);
      expect(meetsMinTap((await row.boundingBox())?.height)).toBe(true);

      // Counted in the summary line: no questions, one project that needs the owner.
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
