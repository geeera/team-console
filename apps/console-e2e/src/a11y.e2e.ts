import type { Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * axe on every screen and every dialog of the app, in light and dark, at the project's width (390 px iPhone and
 * desktop). Serious and critical violations fail the run.
 */

interface Screen {
  readonly name: string;
  readonly phoneOnly?: boolean;
  /** Opens the screen and waits until its content (not a loading state) is on it. */
  open(page: Page): Promise<void>;
}

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 900;

async function visit(page: Page, path: string, ready: (page: Page) => Promise<void>): Promise<void> {
  await page.goto(path);
  await ready(page);
}

const SCREENS: readonly Screen[] = [
  {
    name: 'Needs you',
    open: (page) => visit(page, '/needs-you', (p) => expect(p.locator('li[data-number="72"]')).toBeVisible()),
  },
  {
    name: 'All projects',
    open: (page) => visit(page, '/overview', (p) => expect(p.getByTestId('overview-row')).toHaveCount(2)),
  },
  {
    name: 'Settings',
    open: (page) => visit(page, '/settings', (p) => expect(p.getByTestId('setup-chip')).toHaveCount(2)),
  },
  {
    name: 'Settings, archive dialog',
    open: async (page) => {
      await visit(page, '/settings', (p) => expect(p.getByTestId('archive-private-product')).toBeVisible());
      await page.getByTestId('archive-private-product').click();
      await expect(page.getByRole('alertdialog')).toContainText(
        ru('settings.archive.title', { name: 'private-product' }),
      );
    },
  },
  {
    name: 'New project',
    open: (page) =>
      visit(page, '/settings/projects/new', (p) => expect(p.getByTestId('repo-field')).toBeVisible()),
  },
  {
    name: 'New project, refused',
    open: async (page) => {
      await visit(page, '/settings/projects/new', (p) => expect(p.getByTestId('repo-field')).toBeVisible());
      await page.getByTestId('repo-field').fill('acme/site');
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('add-result')).toContainText(ru('settings.add.refused.title'));
    },
  },
  {
    name: 'Project setup, ready',
    open: (page) =>
      visit(page, '/settings/projects/team-console', (p) =>
        expect(p.locator('[data-step="app"] [data-testid="step-state"]')).toHaveText(
          ru('settings.step.done'),
        ),
      ),
  },
  {
    name: 'Project setup, a step missing',
    open: (page) =>
      visit(page, '/settings/projects/private-product', (p) =>
        expect(p.locator('[data-step="routine"] [data-testid="step-state"]')).toHaveText(
          ru('settings.step.missing'),
        ),
      ),
  },
  {
    name: 'Project questions',
    open: (page) =>
      visit(page, '/p/team-console/questions', (p) =>
        expect(p.locator('li[data-number="72"]')).toBeVisible(),
      ),
  },
  {
    name: 'Reason sheet',
    open: async (page) => {
      await visit(page, '/p/team-console/questions', (p) =>
        expect(p.locator('li[data-number="72"]')).toBeVisible(),
      );
      await page.locator('li[data-number="72"] [data-command="reject"]').click();
      await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
    },
  },
  {
    name: 'Untrusted item warning',
    open: async (page) => {
      await visit(page, '/needs-you', (p) => expect(p.locator('li[data-number="90001"]')).toBeVisible());
      await page.locator('li[data-number="90001"] [data-command="approve"]').click();
      await expect(page.getByRole('alertdialog')).toContainText(ru('answer.confirm.untrustedTitle'));
    },
  },
  {
    // The pane on a wide screen, the sheet on the phone (#114); waits for the team status read from the stack.
    name: 'Commands panel',
    open: async (page) => {
      await visit(page, '/p/team-console/questions', (p) =>
        expect(p.locator('li[data-number="72"]')).toBeVisible(),
      );
      await page.getByTestId('commands-open').click();
      await expect(page.getByTestId('team-state')).toBeVisible();
    },
  },
  {
    // The chat tab is a placeholder until #17 ships (#203): the route redirects to the default section.
    name: 'Project chat (redirects to the default section)',
    open: (page) =>
      visit(page, '/p/team-console/chat', async (p) => {
        await expect(p).toHaveURL(/\/p\/team-console\/questions$/);
        await expect(p.locator('li[data-number="72"]')).toBeVisible();
      }),
  },
  {
    name: 'Project board',
    open: (page) =>
      visit(page, '/p/team-console/board', async (p) => {
        await expect(p.getByTestId('loading')).toHaveCount(0);
        await expect(
          p.getByTestId('stats').or(p.getByTestId('no-sprint')).or(p.getByTestId('empty-sprint')),
        ).toBeVisible();
      }),
  },
  {
    name: 'Project artifacts',
    open: (page) =>
      visit(page, '/p/team-console/artifacts', (p) =>
        expect(p.getByTestId('artifact').first()).toBeVisible(),
      ),
  },
  {
    name: 'Project not found',
    open: (page) =>
      visit(page, '/p/no-such-project/questions', (p) =>
        expect(p.getByTestId('not-found-back')).toBeVisible(),
      ),
  },
  {
    name: 'No such page',
    open: (page) =>
      visit(page, '/no/such/page', (p) => expect(p.getByTestId('not-found-back')).toBeVisible()),
  },
  {
    name: 'Projects sheet',
    phoneOnly: true,
    open: async (page) => {
      await visit(page, '/needs-you', (p) => expect(p.locator('li[data-number="72"]')).toBeVisible());
      await page.getByRole('button', { name: ru('shell.openSwitcher') }).click();
      await expect(
        page.getByRole('dialog').getByRole('button', { name: ru('shell.addProject') }),
      ).toBeVisible();
    },
  },
];

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console', 'geeera/private-product']);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    for (const screen of SCREENS) {
      test(`axe: ${screen.name}`, async ({ page }) => {
        test.skip(screen.phoneOnly === true && !isPhone(page), 'the Projects sheet exists on the phone only');
        await screen.open(page);
        // Proves the theme under test is the one the tokens render, not just the emulated preference.
        await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);
        await expectAccessible(page, `${screen.name} (${colorScheme})`);
      });
    }
  });
}
