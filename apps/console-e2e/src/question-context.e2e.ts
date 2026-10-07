import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * Questions with enough context to decide in the console (#276): the team's sections of the issue body as plain text
 * in a fixed order, a fallback for older questions, and never the raw answer line. Fixture #90004 has every section
 * (and a hostile tag in one), #90007 none, #90001 is from outside the team.
 */

const card = (page: Page, issue: number): Locator => page.locator(`li[data-number="${issue}"]`);
const ANSWER_LINE = /Your answer|Ваш ответ|Твой ответ/u;
const STORYBOOK = 'https://team-console-storybook.pages.dev';

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('a team question shows each section in its slot, in order, as text', async ({ page }) => {
  await page.goto('/needs-you');
  const design = card(page, 90004);

  await expect(design.getByRole('heading', { name: 'Экран дизайна и демо' })).toBeVisible();
  await expect(design.getByRole('article', { name: 'Экран дизайна и демо' })).toBeVisible();
  await expect(design.getByTestId('github-title')).toHaveText(
    `${ru('questions.onGitHub')} Дизайн #20: экран дизайна и демо`,
  );
  await expect(design.getByTestId('question-text')).toHaveText(
    'Утвердить дизайн экрана «Дизайн и демо»: дизайны, которые ждут вашего согласования, и открытое демо спринта на одном экране.',
  );
  const recommendation = design.getByTestId('recommendation');
  await expect(recommendation).toContainText(ru('questions.recommends'));
  await expect(recommendation).toContainText(
    `${ru('questions.recommend.approveDesign')} Повторяет уже утверждённые карточки «Ждут вас». Новых паттернов нет.`,
  );
  const outcomes = design.getByTestId('outcomes');
  await expect(outcomes.locator('dt')).toHaveText([
    ru('questions.outcome.ifApproveDesign'),
    ru('questions.outcome.ifReject'),
  ]);
  await expect(outcomes.locator('dd')).toHaveText([
    'Разработчик начнёт #20 по этому дизайну, к демо 16 октября.',
    'Дизайнер переделает экран по вашему комментарию. #20 подождёт.',
  ]);
  await expect(design.getByTestId('cost')).toHaveText(
    `${ru('questions.cost')} Бесплатно. Риск низкий: новых зависимостей нет.`,
  );

  // Top to bottom: question, recommendation, outcomes, cost, then the answer buttons.
  const tops = await Promise.all(
    [
      design.getByTestId('question-text'),
      recommendation,
      outcomes,
      design.getByTestId('cost'),
      design.locator('[data-command="approve"]'),
    ].map(async (locator) => (await locator.boundingBox())?.y ?? Number.NaN),
  );
  expect(tops).toEqual([...tops].sort((a, b) => a - b));

  // The hostile tag in a section never became an element, nor visible markup.
  await expect(design.locator('img')).toHaveCount(0);
  await expect(design).not.toContainText('onerror');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expectAccessible(page, 'Needs you, question with context');
});

test('an older question without the sections falls back to its first paragraph and the answer options', async ({
  page,
}) => {
  await page.goto('/p/team-console/questions');
  const older = card(page, 90007);

  await expect(older.getByRole('heading', { name: 'Экспорт доски в CSV' })).toBeVisible();
  await expect(older.getByTestId('github-title')).toHaveCount(0);
  await expect(older.getByTestId('question-text')).toHaveText(
    'Вопрос о составе продукта: команда предлагает экспорт доски.',
  );
  await expect(older.getByTestId('recommendation')).toContainText(ru('questions.recommend.approve'));
  await expect(older.getByTestId('outcomes').locator('dd')).toHaveText(['Добавить экспорт в CSV', 'Почему']);
  for (const raw of ['/approve', '/reject', 'рекомендую']) {
    await expect(older).not.toContainText(raw);
  }
  // An outsider's question: marked, and nothing read from its body into the card.
  const outsider = card(page, 90001);
  await expect(outsider.getByTestId('untrusted')).toBeVisible();
  await expect(outsider.getByTestId('outcomes')).toHaveCount(0);
  await expect(outsider.getByTestId('question-text')).toHaveCount(0);
  await expectAccessible(page, 'Project questions, fallback and outsider');
});

for (const path of ['/needs-you', '/p/team-console/questions', '/p/team-console/demo']) {
  test(`${path}: the raw answer line is never shown`, async ({ page, outsideRequests }) => {
    // The demo screen frames the fixture's Storybook prototype (#20); answer it locally instead of the internet.
    outsideRequests.allow(STORYBOOK);
    await page.route(`${STORYBOOK}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html lang="en"><head><title>Storybook</title></head><body><main>Preview</main></body></html>',
      }),
    );
    await page.goto(path);
    await expect(card(page, 90004)).toBeVisible();
    for (const details of await page.locator('details').all()) {
      await details.evaluate((element) => element.setAttribute('open', ''));
    }
    await expect(page.locator('main')).not.toContainText(ANSWER_LINE);
  });
}

test('on the phone, the design card’s answer buttons are in the first screen once the card is at the top', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 520, 'the fold check is for the 390 × 844 phone');
  await page.goto('/needs-you');
  const design = card(page, 90004);
  await design.getByRole('heading', { name: 'Экран дизайна и демо' }).evaluate((heading) =>
    heading.closest('li')?.scrollIntoView({ block: 'start' }),
  );
  const buttons = await design.locator('[data-command]').last().boundingBox();
  const viewport = page.viewportSize()?.height ?? 0;
  expect((buttons?.y ?? Infinity) + (buttons?.height ?? 0)).toBeLessThanOrEqual(viewport);
});
