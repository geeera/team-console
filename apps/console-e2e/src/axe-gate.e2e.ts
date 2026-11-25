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
          page
            .locator(target)
            .evaluate((node) => node.matches('li[data-number="72"] tc-card [tc-card-title]')),
        ),
      );
      expect(flagged).toContain(true);
    });
  }
});

/**
 * The wait before the scan (#971): a paused animation is a still frame and must not hold it (a hovered Undo toast's
 * hairline used to, for the whole test timeout), and one that will not end soon fails the scan at once, named.
 */
test.describe('waiting for animations', () => {
  const content = `<!doctype html>
    <html lang="ru">
      <head><title>axe gate</title></head>
      <body><main><h1>Проверка</h1><p id="slow" class="bar">Полоса</p></main></body>
    </html>`;

  test('a paused animation does not hold the scan', async ({ page }) => {
    await page.setContent(content);
    // Like the Undo hairline it shrinks, not fades: a frame frozen at partial opacity would rightly fail contrast.
    await page.locator('#slow').evaluate((bar) => {
      bar.animate({ transform: ['scaleX(1)', 'scaleX(0)'] }, { duration: 10_000 }).pause();
    });
    const started = Date.now();
    expect(await blockingViolations(page)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a long running animation fails the scan at once, naming it and its element', async ({ page }) => {
    await page.setContent(content);
    await page.locator('#slow').evaluate((bar) => {
      bar.animate({ opacity: [0.2, 1] }, { duration: 10_000, id: 'slow-fade' });
    });
    const started = Date.now();
    await expect(blockingViolations(page)).rejects.toThrow(/slow-fade on p#slow\.bar \(\d+ ms left\)/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/**
 * A lazy route's chunk can arrive after the shell is up (#971): the scan must wait for the routed page, neither
 * measuring it mid-fade nor passing before it exists. Held back 300 ms, this failed `color-contrast` on `h1`,
 * `.overview__count`, … before the wait.
 */
test.describe('a route still loading', () => {
  test.beforeAll(async ({ stack }) => {
    requireLocalStack(stack);
    await seed(stack, ['geeera/team-console']);
  });

  test('the scan waits for the routed page to mount and settle', async ({ page }) => {
    await page.route('**/chunk-*.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fallback();
    });
    await page.goto('/overview');
    await expect(page.locator('#tc-main')).toBeAttached();
    expect(await blockingViolations(page)).toEqual([]);
    expect(await page.locator('#tc-main tc-overview-page h1').isVisible()).toBe(true);
  });
});
