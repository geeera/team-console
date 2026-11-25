import AxeBuilder from '@axe-core/playwright';
import { errors, type Page } from '@playwright/test';
import { type MotionReport, movedDuringScanMessage, watchMotion } from './finish-animations';
import { finishAnimations } from './motion';

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
 * Resolves once the page has gone `quietMs` without a DOM mutation, or `timeoutMs` has passed regardless (a
 * continuously updating region, e.g. a live countdown, must not hang the scan). A widget that mounts from its own
 * async store — the GitHub repositories block on `/overview`, independent of the route's own fade — can still be
 * arriving, and with it a fresh fade of its own, after the route-enter animation already finished and was waited
 * on (#952); checking only "no animation running right now" misses that.
 */
async function domIdle(page: Page, quietMs: number, timeoutMs: number): Promise<void> {
  await page.evaluate(
    ({ quietMs, timeoutMs }) =>
      new Promise<void>((resolve) => {
        let quietTimer: ReturnType<typeof setTimeout>;
        const finish = () => {
          clearTimeout(deadline);
          observer.disconnect();
          resolve();
        };
        const observer = new MutationObserver(() => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, quietMs);
        });
        quietTimer = setTimeout(finish, quietMs);
        const deadline = setTimeout(finish, timeoutMs);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      }),
    { quietMs, timeoutMs },
  );
}

/** A lazy route's chunk can take this long to arrive; past it the scan fails, saying what it waited for. */
const ROUTES_TIMEOUT_MS = 10_000;
/** The DOM counts as idle after this long without a mutation… */
const DOM_QUIET_MS = 80;
/** …or once this much has passed regardless: a live countdown mutates forever and must not hold the scan. */
const DOM_IDLE_TIMEOUT_MS = 2000;
/**
 * A scan is trusted only if nothing animated while axe ran; otherwise the page is brought to rest and scanned again.
 * A poll landing mid-scan costs one extra scan; five in a row is a page that never stands still, and fails, named.
 */
const MAX_SCANS = 5;

/**
 * Resolves once the app shell is up (`#tc-main`) and every `.m-route` container (#506) has its routed page mounted
 * beside its `<router-outlet>`. A lazy route's chunk can still be downloading after the shell around it is up —
 * badge-roll's first scan waited only for the sidebar badge (#971) — and nothing mutates the DOM while it downloads,
 * so `domIdle()`'s quiet window passes and the page mounts, fading in, while axe measures it (contrast on `h1`,
 * `.overview__count`, … reproduced by holding the route's chunk back 300 ms); held back longer, axe passed a page
 * that had not arrived at all. Before the shell renders there is no `.m-route` yet, so on an app page (`tc-root`)
 * the shell itself is awaited too, or the check would pass on nothing. The signed-out screen
 * (`tc-session-expired`) has no shell, and a page that is not the app has nothing to wait for.
 */
async function routesMounted(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        if (
          document.querySelector('tc-root') !== null &&
          document.querySelector('tc-session-expired') === null
        ) {
          if (document.querySelector('#tc-main') === null) {
            return false;
          }
        }
        return Array.from(document.querySelectorAll('.m-route')).every((outlet) =>
          Array.from(outlet.children).some((child) => child.tagName !== 'ROUTER-OUTLET'),
        );
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      throw new Error(
        `axe gate: the app shell (#tc-main) or a route outlet (.m-route) still had no page after ` +
          `${String(timeoutMs)} ms, so there is nothing settled to scan yet. Wait for the screen the test means first.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Brings the page to rest for a measurement: the routed page is mounted, late async content has arrived, and every
 * finite animation is at its end state — mid-way through a sheet's entrance, or the #506 route fade/rise, a box is
 * still moving. Endless animations (spinners, the live dot) and paused ones are left alone; the axe gate itself
 * (`blockingViolations`) is stricter about them.
 */
export async function animationsSettled(page: Page): Promise<void> {
  await routesMounted(page, ROUTES_TIMEOUT_MS);
  await domIdle(page, DOM_QUIET_MS, DOM_IDLE_TIMEOUT_MS);
  await finishAnimations(page, 'leave');
}

const prefersReducedMotion = (page: Page): Promise<boolean> =>
  page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * Turns reduced motion on for the scan and returns the way back. Under it the UI's endless animations stop
 * (`tc-spinner`, `tc-live-dot`) and every enter is a short fade, so little is left to finish and nothing is left
 * that cannot be. A test that already runs reduced (its own `emulateMedia`, or `test.use`) is left as it is.
 *
 * Going back lengthens the durations again, which can put an animation that was finished early back in mid-flight;
 * those are finished once more, so a scan never leaves the page moving.
 */
async function reduceMotion(page: Page): Promise<() => Promise<void>> {
  if (await prefersReducedMotion(page)) {
    return () => Promise.resolve();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return async () => {
    await page.emulateMedia({ reducedMotion: null });
    // `null` falls back to the context's setting; a page that had overridden a reduced context is put back by name.
    if (await prefersReducedMotion(page)) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await finishAnimations(page, 'leave');
  };
}

/**
 * One axe pass over a page that stood still for all of it. Before each scan every finite animation is finished
 * (#971: finished, not waited for) and an endless one fails the gate by name. An animation that starts while axe
 * runs — a poll's new row fading in — would be measured mid-fade, or skipped while still transparent, so that scan
 * is thrown away and the page scanned again.
 */
async function stillScan(page: Page): Promise<AxeResults> {
  let moved: MotionReport[] = [];
  for (let scan = 0; scan < MAX_SCANS; scan++) {
    await domIdle(page, DOM_QUIET_MS, DOM_IDLE_TIMEOUT_MS);
    await finishAnimations(page, 'fail');
    const watch = await page.evaluateHandle(watchMotion);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    moved = await watch.evaluate((motion) => motion.stop());
    await watch.dispose();
    if (moved.length === 0) {
      return results;
    }
  }
  throw new Error(movedDuringScanMessage(moved, MAX_SCANS));
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

/**
 * Serious and critical axe violations on the page as it is now (dialogs and sheets included), measured on its end
 * state: reduced motion for the length of the scan, every finite animation finished, nothing moving while axe runs.
 */
export async function blockingViolations(page: Page): Promise<BlockingViolation[]> {
  await routesMounted(page, ROUTES_TIMEOUT_MS);
  const restoreMotion = await reduceMotion(page);
  let blocking: BlockingViolation[];
  try {
    blocking = await scanForBlocking(page);
  } catch (error: unknown) {
    try {
      await restoreMotion();
    } catch (restoreError: unknown) {
      throw new AggregateError(
        [error, restoreError],
        'the axe scan failed, and so did restoring the motion preference after it',
      );
    }
    throw error;
  }
  await restoreMotion();
  return blocking;
}

async function scanForBlocking(page: Page): Promise<BlockingViolation[]> {
  const results = await stillScan(page);
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
