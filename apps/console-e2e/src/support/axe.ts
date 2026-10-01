import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// WCAG 2.2 A/AA plus axe's best practices; only these impacts fail the run (#14).
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

export interface BlockingViolation {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  readonly targets: readonly string[];
}

/**
 * Waits until every finite animation has finished: mid-way through a sheet's entrance its text is still partly
 * transparent, and axe would measure contrast on a frame no one reads. Endless ones (spinners) are left alone.
 */
export async function animationsSettled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity,
      ),
  );
}

/** Serious and critical axe violations on the page as it is now (dialogs and sheets included). */
export async function blockingViolations(page: Page): Promise<BlockingViolation[]> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? '',
      help: violation.help,
      targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }));
}
