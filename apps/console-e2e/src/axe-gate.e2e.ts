import { blockingViolations } from './support/axe';
import { expect, requireLocalStack, test } from './support/fixtures';
import { seed } from './support/stack';

/**
 * The a11y gate itself: a page with deliberate serious and critical violations must be reported (target-size even
 * after the re-check where the control would be tapped), and a minor one must not fail the run. Without this, a misconfigured axe run (wrong tags, wrong impacts) would pass
 * every screen silently.
 */
test('reports serious and critical violations and ignores minor ones', async ({ page }) => {
  await page.setContent(`<!doctype html>
    <html lang="ru">
      <head><title>axe gate</title></head>
      <body>
        <main>
          <h1>Проверка</h1>
          <p style="color: #bbb; background: #fff">Бледный текст</p>
          <button type="button"></button>
          <p>
            <button type="button" aria-label="Один" style="width: 10px; height: 10px; padding: 0; border: 0"></button
            ><button type="button" aria-label="Два" style="width: 10px; height: 10px; padding: 0; border: 0"></button>
          </p>
          <h3>Пропущен уровень заголовка</h3>
        </main>
      </body>
    </html>`);

  const violations = await blockingViolations(page);

  expect(violations.map((violation) => `${violation.id}:${violation.impact}`).sort()).toEqual([
    'button-name:critical',
    'color-contrast:serious',
    'target-size:serious',
  ]);
});

/**
 * axe reports text on a background gradient as `incomplete`, not as a violation (#146): the gate must count it, or a
 * contrast regression on such text would pass.
 */
test('reports text whose contrast axe cannot measure on a background gradient', async ({ page }) => {
  await page.setContent(`<!doctype html>
    <html lang="ru">
      <head><title>axe gate</title></head>
      <body>
        <main>
          <h1>Проверка</h1>
          <div style="background: #fff linear-gradient(#fff, #eee)"><p style="color: #ddd">Текст на градиенте</p></div>
        </main>
      </body>
    </html>`);

  const violations = await blockingViolations(page);

  expect(violations.map((violation) => violation.id)).toEqual(['color-contrast']);
  expect(violations[0]?.targets).toEqual(['p']);
});

/** The hole #146 found: a contrast regression on text in a real question card (`tc-card`) must fail the gate. */
test.describe('question card', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console']);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`low-contrast card text fails the gate (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/p/team-console/questions');
      await expect(page.locator('li[data-number="72"] tc-card')).toBeVisible();
      await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);
      expect(await blockingViolations(page)).toEqual([]);

      // The card's second surface as its title colour: about 1.05:1 on the card in either theme. Set through the
      // CSSOM, which the app's CSP allows (an injected <style> it would refuse).
      await page
        .locator('li[data-number="72"] tc-card [tc-card-title]')
        .evaluate((title: HTMLElement) => title.style.setProperty('color', 'var(--surface-2)', 'important'));
      const violations = await blockingViolations(page);

      const contrast = violations.filter((violation) => violation.id === 'color-contrast');
      expect(contrast).toHaveLength(1);
      // axe's selector for the node it flagged is the card title itself.
      const flagged = await Promise.all(
        (contrast[0]?.targets ?? []).map((target) =>
          page.locator(target).evaluate((node) => node.matches('li[data-number="72"] tc-card [tc-card-title]')),
        ),
      );
      expect(flagged).toContain(true);
    });
  }
});
