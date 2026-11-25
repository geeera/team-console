import AxeBuilder from '@axe-core/playwright';
import { errors, type Page } from '@playwright/test';
import {
  type AnimationReport,
  restartingAnimationsMessage,
  type SettleOptions,
  settleRound,
  stuckAnimationsMessage,
} from './animation-settle';

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

/**
 * Resolves once every `.m-route` container (#506) has its routed page mounted beside its `<router-outlet>`. A lazy
 * route's chunk can still be downloading after the shell around it is up — badge-roll's first scan waited only for
 * the sidebar badge (#971) — and nothing mutates the DOM while it downloads, so `domIdle()`'s quiet window passes and
 * the page mounts, fading in, while axe measures it (contrast on `h1`, `.overview__count`, … reproduced by holding
 * the route's chunk back 300 ms); held back longer, axe passed a page that had not arrived at all.
 */
async function routesMounted(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.m-route')).every((outlet) =>
          Array.from(outlet.children).some((child) => child.tagName !== 'ROUTER-OUTLET'),
        ),
      undefined,
      { timeout: timeoutMs },
    );
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      throw new Error(
        `animationsSettled: a route outlet (.m-route) still had no page after ${String(timeoutMs)} ms, so there is ` +
          'nothing settled to scan yet. Wait for the screen the test means first.',
        { cause: error },
      );
    }
    throw error;
  }
}

/** One round can wait up to this long per animation; the #506 motion tokens top out at 1.6 s (`--dur-pulse`). */
const SETTLE: SettleOptions = { quietFrames: 4, maxWaitMs: 3000, slackMs: 250 };
const SETTLE_ROUNDS = 20;

/**
 * Waits until every finite animation has finished: mid-way through a sheet's entrance, or the #506 route fade/rise,
 * its text is still partly transparent, and axe would measure contrast on a frame no one reads. Endless ones
 * (spinners, the live dot) and paused ones (a hovered Undo toast's hairline) are left alone.
 *
 * A DOM swap's animation (a navigation, an `@if` block replaced) is not always constructed on the very first frame
 * read — more so under CPU load (#952) — so only `SETTLE.quietFrames` quiet frames in a row are trusted; anything
 * seen running is waited out and the quiet check runs again, in case another one started meanwhile. Each wait is
 * bounded (#971): an animation that outlives it, or a page that keeps starting new ones, fails the scan with the
 * animation and element named instead of hanging until the test timeout.
 */
export async function animationsSettled(page: Page): Promise<void> {
  await routesMounted(page, 10_000);
  await domIdle(page, 80, 2000);
  let lastSeen: readonly AnimationReport[] = [];
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const result = await page.evaluate(settleRound, SETTLE);
    if (result.quiet) {
      return;
    }
    if (result.stuck.length > 0) {
      throw new Error(stuckAnimationsMessage(result.stuck, SETTLE.maxWaitMs));
    }
    lastSeen = result.running.length > 0 ? result.running : lastSeen;
  }
  throw new Error(restartingAnimationsMessage(lastSeen, SETTLE_ROUNDS));
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
