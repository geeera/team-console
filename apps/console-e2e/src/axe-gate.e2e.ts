import { blockingViolations } from './support/axe';
import { expect, test } from './support/fixtures';

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
