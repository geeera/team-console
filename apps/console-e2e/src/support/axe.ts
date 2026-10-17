import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// WCAG 2.2 A/AA plus axe's best practices; only these impacts fail the run (#14).
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

/**
 * axe leaves text on a background gradient `incomplete` instead of failing it, so a contrast regression there would
 * pass the run unseen (#146). Text the gate cannot measure counts as a contrast failure; the fix is a solid token
 * background, never a gradient behind text.
 */
const UNMEASURABLE_CONTRAST: ReadonlySet<string> = new Set(['bgGradient']);

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

/**
 * `target-size` counts the part of a control hidden under a fixed bar (the phone's tab bar) as missing, so a button
 * that merely scrolled under the bar fails depending on where the page happens to be. Each such control is checked
 * again where the owner would tap it — scrolled to the middle of the screen; only a failure there counts.
 */
async function failsWhereTapped(page: Page, selector: string): Promise<boolean> {
  const control = page.locator(selector);
  if ((await control.count()) !== 1) {
    return true;
  }
  await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
  const results = await new AxeBuilder({ page }).include(selector).withRules(['target-size']).analyze();
  return results.violations.length > 0;
}

/** Serious and critical axe violations on the page as it is now (dialogs and sheets included). */
export async function blockingViolations(page: Page): Promise<BlockingViolation[]> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking: BlockingViolation[] = [];
  const unmeasurable = unmeasurableContrast(results.incomplete);
  if (unmeasurable !== undefined) {
    blocking.push(unmeasurable);
  }
  for (const violation of results.violations) {
    if (!BLOCKING_IMPACTS.has(violation.impact ?? '')) {
      continue;
    }
    let targets = violation.nodes.map((node) => node.target.join(' '));
    if (violation.id === 'target-size') {
      const failing: string[] = [];
      for (const target of targets) {
        if (await failsWhereTapped(page, target)) {
          failing.push(target);
        }
      }
      targets = failing;
    }
    if (targets.length > 0) {
      blocking.push({
        id: violation.id,
        impact: violation.impact ?? '',
        help: violation.help,
        targets: targets.slice(0, 5),
      });
    }
  }
  return blocking;
}

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

/** `color-contrast` nodes axe could not measure because of a background gradient, as one blocking entry. */
function unmeasurableContrast(incomplete: AxeResults['incomplete']): BlockingViolation | undefined {
  const contrast = incomplete.find((result) => result.id === 'color-contrast');
  if (contrast === undefined) {
    return undefined;
  }
  const targets = contrast.nodes
    .filter((node) =>
      [...node.any, ...node.all, ...node.none].some((check) => {
        const data: unknown = check.data;
        return (
          typeof data === 'object' &&
          data !== null &&
          'messageKey' in data &&
          typeof data.messageKey === 'string' &&
          UNMEASURABLE_CONTRAST.has(data.messageKey)
        );
      }),
    )
    .map((node) => node.target.join(' '));
  if (targets.length === 0) {
    return undefined;
  }
  return {
    id: 'color-contrast',
    impact: contrast.impact ?? 'serious',
    help: `${contrast.help} (unmeasurable: background gradient)`,
    targets: targets.slice(0, 5),
  };
}
