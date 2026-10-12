import { commandLines } from '@shared/owner-grammar';
import type { Locator, Page } from '@playwright/test';
import { animationsSettled } from './support/axe';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { fakeComments, seed } from './support/stack';

/**
 * Design previews on the question cards (#290, spec #276 §3–§6), at 390×844 (iphone) and 1440×900 (desktop): design
 * question #90004 has seven screens at the head of its pull request #176 — five for the phone, two for the Mac. Its
 * card shows three of them, phone first, «+4» on the last and «Все экраны (7)». Tapping a preview opens the #277
 * viewer on that screen, with the card's answers in the viewer's footer; «Утвердить» there answers once, closes the
 * viewer and folds the card into its receipt. An outsider's design question (#90001 is a question, so its marks are
 * covered in question-context) never gets a preview.
 */
test.describe.configure({ mode: 'serial' });

const ISSUE = 90004;
const FOLDER = `docs/design/${ISSUE}-demo-screen`;

const card = (page: Page): Locator => page.locator(`li[data-number="${ISSUE}"]`);
const previews = (page: Page): Locator => card(page).getByTestId('question-preview');
const dialog = (page: Page): Locator => page.locator('tc-sheet-container[role="dialog"]');

async function showCard(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(previews(page)).toHaveCount(3);
}

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

for (const path of ['/p/team-console/questions', '/needs-you']) {
  test(`${path}: the design card shows three screens, «+4» and «Все экраны (7)»`, async ({ page }) => {
    await showCard(page, path);
    const list = card(page).getByRole('list', { name: ru('questions.previews.label', { n: 7 }) });
    await expect(list).toBeVisible();
    expect(await previews(page).evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-path')))).toEqual([
      `${FOLDER}/phone-01-list.png`,
      `${FOLDER}/phone-02-detail.png`,
      `${FOLDER}/phone-03-answer.jpg`,
    ]);
    await expect(previews(page).first()).toHaveAccessibleName(
      ru('questions.previews.thumbAria', { i: 1, n: 7, caption: 'Список дизайнов' }),
    );
    // Each preview is its own screen, a decorative image that actually arrived.
    const images = card(page).getByTestId('design-thumb');
    await expect(images).toHaveCount(3);
    for (const image of await images.all()) {
      await expect(image).toHaveAttribute('alt', '');
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
    }
    await expect(previews(page).nth(2).getByTestId('question-previews-more')).toHaveText('+4');
    await expect(card(page).getByTestId('question-previews-all')).toHaveText(
      ru('questions.previews.all', { n: 7 }),
    );
    await expect(card(page).getByTestId('design-summary')).toHaveText(`#${ISSUE} · 7 экранов · iPhone и Mac`);

    // Previews sit between the recommendation and the outcomes, above the answer buttons (#276 §3 order).
    const tops = await Promise.all(
      [
        card(page).getByTestId('recommendation'),
        card(page).getByTestId('question-previews'),
        card(page).getByTestId('outcomes'),
        card(page).locator('[data-command="approve"]'),
      ].map(async (locator) => (await locator.boundingBox())?.y ?? Number.NaN),
    );
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    // Nothing sticks out sideways (#281).
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expectAccessible(page, `${path}, design card with previews`);
  });
}

test('tapping a preview opens the viewer on that screen; closing returns focus to the preview', async ({ page }) => {
  await showCard(page, '/p/team-console/questions');
  const second = previews(page).nth(1);
  await second.click();
  await expect(dialog(page)).toBeVisible();
  await animationsSettled(page);
  // The phone's screen, on the phone device, on the Mac too: the viewer opens where the owner tapped.
  await expect(page.locator('[data-testid="viewer-device"][data-device="phone"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('viewer-position')).toHaveText('2 из 5 · detail');
  const screen = page.getByTestId('viewer-screen');
  await expect(screen).toHaveAttribute('data-path', `${FOLDER}/phone-02-detail.png`);
  await expect.poll(() => screen.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  // The card's answers are in the viewer's footer.
  const actions = page.getByTestId('viewer-actions');
  await expect(actions.locator('[data-command="approve"]')).toHaveText(ru('answer.command.approve'));
  await expect(actions.locator('[data-command="reject"]')).toBeVisible();
  await expect(page.locator('.tc-sheet__foot')).toBeInViewport();
  await expectAccessible(page, 'Design viewer opened from a question card');

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(second).toBeFocused();

  // «Все экраны» opens the grid of the same design.
  await card(page).getByTestId('question-previews-all').click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('[data-testid="viewer-mode"][data-mode="grid"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('viewer-grid-item').first()).toBeVisible();
});

test('a failed answer inside the viewer: the error fits, the screen stays whole, no stray scroller (#298)', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 520, 'the short stage is the 390 × 844 phone');
  await page.route(`**/api/v1/projects/team-console/issues/${ISSUE}/answer`, (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://team-console/problems/github-unavailable',
        title: 'GitHub unavailable',
        status: 502,
      }),
    }),
  );
  await showCard(page, '/p/team-console/questions');
  await previews(page).first().click();
  await expect(dialog(page)).toBeVisible();
  const screen = page.getByTestId('viewer-screen');
  await expect.poll(() => screen.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  await page.getByTestId('viewer-actions').locator('[data-command="approve"]').click();
  await expect(page.getByTestId('viewer-actions').getByTestId('answer-error')).toBeVisible();
  await animationsSettled(page);

  // The taller footer shrinks the screen instead of making the stage scroll.
  const stage = page.getByTestId('viewer-stage');
  await expect
    .poll(() => stage.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  const [stageBox, screenBox] = await Promise.all([stage.boundingBox(), screen.boundingBox()]);
  expect(screenBox?.height ?? 0).toBeGreaterThan(0);
  expect(screenBox?.y ?? -1).toBeGreaterThanOrEqual(stageBox?.y ?? 0);
  expect((screenBox?.y ?? 0) + (screenBox?.height ?? 0)).toBeLessThanOrEqual(
    (stageBox?.y ?? 0) + (stageBox?.height ?? 0) + 1,
  );
  await expect(page.locator('.tc-sheet__foot')).toBeInViewport();
  await expectAccessible(page, 'Design viewer with a failed answer in the footer');
});

test('«Утвердить» inside the viewer answers once, closes it and folds the card into its receipt', async ({
  page,
  stack,
}) => {
  const before = (await fakeComments(stack, ISSUE)).length;
  await showCard(page, '/needs-you');
  await previews(page).first().click();
  await expect(dialog(page)).toBeVisible();
  await animationsSettled(page);

  await page.getByTestId('viewer-actions').locator('[data-command="approve"]').click();
  await expect(dialog(page)).toBeHidden();
  const receipt = card(page).locator('tc-receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText(ru('answer.receipt.status.approve'));
  await expect(receipt).toBeFocused();
  await expect(page.getByTestId('announcement')).toContainText(`#${ISSUE}`);

  const comments = await fakeComments(stack, ISSUE);
  expect(comments).toHaveLength(before + 1);
  expect(commandLines(comments.at(-1)?.body ?? '')).toEqual([{ command: 'approve', text: '' }]);
  await expectAccessible(page, 'Needs you after answering from the viewer');
});
