import type { Page } from '@playwright/test';
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
 * Motion before the scan (#971): animations are finished, not waited for. No animation's own clock can hold the scan
 * (a hovered Undo toast's paused hairline used to, for the whole test timeout) or fail it (WebKit's lagging clock
 * under load did, #979/#980), and axe measures the end state.
 */
test.describe('animations before the scan', () => {
  // Readable at full opacity only: mid-fade it fails contrast, which is what a scan that did not finish it reports.
  const content = `<!doctype html>
    <html lang="ru">
      <head><title>axe gate</title></head>
      <body style="background: #fff">
        <main><h1>Проверка</h1><p id="slow" class="bar" style="color: #595959">Полоса</p></main>
      </body>
    </html>`;
  const TEN_MINUTES_MS = 600_000;

  const playState = (page: Page, id: string): Promise<string | undefined> =>
    page.evaluate(
      (animationId) => document.getAnimations().find((animation) => animation.id === animationId)?.playState,
      id,
    );

  test('a long finite animation is finished, and the scan measures its end state', async ({ page }) => {
    await page.setContent(content);
    await page.locator('#slow').evaluate((bar, duration) => {
      bar.animate({ opacity: [0.2, 1] }, { duration, fill: 'forwards', id: 'slow-fade' });
    }, TEN_MINUTES_MS);

    expect(await blockingViolations(page)).toEqual([]);
    expect(await playState(page, 'slow-fade')).toBe('finished');
  });

  test('a paused animation is a still frame: neither waited for nor finished', async ({ page }) => {
    await page.setContent(content);
    // Like the Undo hairline it shrinks, not fades: a frame frozen at partial opacity would rightly fail contrast.
    await page.locator('#slow').evaluate((bar, duration) => {
      bar.animate({ transform: ['scaleX(1)', 'scaleX(0)'] }, { duration, id: 'hairline' }).pause();
    }, TEN_MINUTES_MS);

    expect(await blockingViolations(page)).toEqual([]);
    expect(await playState(page, 'hairline')).toBe('paused');
  });

  test('an animation left applied past its end is finished, and the scan measures its end state', async ({
    page,
  }) => {
    await page.setContent(content);
    // The state Playwright's WebKit on Linux can leave behind (#1018), staged: finished and applying nothing by its
    // own account, yet still listed, with the style at a frame from mid-way until `finish()` is called on it.
    await page.locator('#slow').evaluate((bar) => {
      bar.style.opacity = '0.2';
      let isLingering = true;
      const lingering = {
        id: 'lingering-fade',
        playState: 'finished',
        effect: {
          getComputedTiming: () => ({ iterations: 1, progress: null }),
          target: bar,
          pseudoElement: null,
        },
        finish: () => {
          isLingering = false;
          bar.style.opacity = '';
        },
      };
      const listed = document.getAnimations.bind(document);
      document.getAnimations = () =>
        isLingering ? [...listed(), lingering as unknown as Animation] : listed();
    });

    expect(await blockingViolations(page)).toEqual([]);
    expect(await page.locator('#slow').evaluate((bar) => getComputedStyle(bar).opacity)).toBe('1');
  });

  test('an endless animation fails the scan, naming it and its element', async ({ page }) => {
    await page.setContent(content);
    await page.locator('#slow').evaluate((bar) => {
      bar.animate({ opacity: [0.2, 1] }, { duration: 400, iterations: Infinity, id: 'pulse' });
    });

    await expect(blockingViolations(page)).rejects.toThrow(
      /endless animation is still running under reduced motion.*: pulse on p#slow\.bar\./,
    );
  });

  test('an animation that starts while axe runs gets the page scanned again', async ({ page }) => {
    await page.setContent(content);
    // axe-core assigns `window.axe` when it is injected for a scan: the fade starts then, once, mid-scan.
    await page.evaluate((duration) => {
      const state = window as unknown as { axe: unknown; fadesStarted: number };
      let axe: unknown;
      state.fadesStarted = 0;
      Object.defineProperty(window, 'axe', {
        configurable: true,
        get: () => axe,
        set: (value: unknown) => {
          axe = value;
          if (state.fadesStarted === 0) {
            state.fadesStarted = 1;
            document.querySelector('#slow')?.animate({ opacity: [0.2, 1] }, { duration, id: 'late-fade' });
          }
        },
      });
    }, TEN_MINUTES_MS);

    expect(await blockingViolations(page)).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { fadesStarted: number }).fadesStarted)).toBe(1);
    expect(await playState(page, 'late-fade')).toBeUndefined();
  });

  test('the scan runs under reduced motion and puts the preference back', async ({ page }) => {
    await page.setContent(content);
    const reduced = () => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Recorded when axe is injected, i.e. during the scan.
    await page.evaluate(() => {
      const state = window as unknown as { axe: unknown; reducedDuringScan: boolean[] };
      let axe: unknown;
      state.reducedDuringScan = [];
      Object.defineProperty(window, 'axe', {
        configurable: true,
        get: () => axe,
        set: (value: unknown) => {
          axe = value;
          state.reducedDuringScan.push(matchMedia('(prefers-reduced-motion: reduce)').matches);
        },
      });
    });
    const duringScan = () =>
      page.evaluate(() => (window as unknown as { reducedDuringScan: boolean[] }).reducedDuringScan);

    expect(await reduced()).toBe(false);
    expect(await blockingViolations(page)).toEqual([]);
    expect(await duringScan()).toEqual([true]);
    expect(await reduced()).toBe(false);

    // A test that asked for reduced motion itself keeps it after the scan.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await blockingViolations(page)).toEqual([]);
    expect(await reduced()).toBe(true);
  });
});

/**
 * A lazy route's chunk can arrive after the shell is up (#971, the badge-roll contrast failure): the scan must wait
 * for the routed page, neither measuring it mid-fade nor passing before it exists. Held back 300 ms, this failed
 * `color-contrast` on `h1`, `.overview__count`, … before the wait.
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
