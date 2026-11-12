import type { Page } from '@playwright/test';

/**
 * Scroll regions (#274, #275): an element with `overflow: auto|scroll` whose content is larger than its box, or the
 * document when it overflows. Besides the document only a column pinned to the viewport may scroll (sticky or fixed
 * and no taller than the screen), because it never moves with the page. Shared by the specs that check "one scroll
 * at a time" (scroll-regions, the date picker #307).
 */
export interface ScrollRegion {
  /** `tag.first-class`, enough to name it in a failure. */
  readonly name: string;
  /** The nearest region it scrolls inside, or `null`. */
  readonly inside: string | null;
  readonly isPinned: boolean;
  /** Whether it sits inside the topmost open dialog. */
  readonly isInTopDialog: boolean;
}

/** Runs in the page: every scroll region, as above. */
export function scrollRegionsOf(): ScrollRegion[] {
  const root = document.documentElement;
  const viewportHeight = root.clientHeight;
  const nameOf = (element: Element): string =>
    element === root ? 'document' : `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''}`;
  const scrolls = (element: HTMLElement): boolean => {
    if (element === root) {
      return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1;
    }
    const style = getComputedStyle(element);
    const canScroll = (overflow: string): boolean => overflow === 'auto' || overflow === 'scroll';
    return (
      (canScroll(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
      (canScroll(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
    );
  };
  const regions = [root, ...Array.from(document.body.querySelectorAll<HTMLElement>('*'))].filter(scrolls);
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
  const topDialog = dialogs.at(-1) ?? null;

  return regions.map((region) => {
    let outer: HTMLElement | null = null;
    let isPinned = false;
    for (let node = region.parentElement; node !== null; node = node.parentElement) {
      if (regions.includes(node)) {
        outer = node;
        break;
      }
    }
    for (let node: HTMLElement | null = region; node !== null && node !== outer; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === 'sticky' || position === 'fixed') {
        // Wholly on the screen, too (#507): a pane sized to the screen but starting below a header ran its last rows
        // and the end of its scrollbar under the bottom edge — a second scroll with a cut-off end.
        const box = region.getBoundingClientRect();
        isPinned = box.top >= -1 && box.bottom <= viewportHeight + 1;
        break;
      }
    }
    return {
      name: nameOf(region),
      inside: outer === null ? null : nameOf(outer),
      isPinned,
      isInTopDialog: topDialog !== null && topDialog.contains(region),
    };
  });
}

/** Everything that scrolls with the page besides the document itself; empty when the document is the one scroll. */
export async function strayScrollsOf(page: Page): Promise<string[]> {
  const regions = await page.evaluate(scrollRegionsOf);
  return regions
    .filter((region) => region.name !== 'document' && !region.isPinned)
    .map((region) => (region.inside === null ? region.name : `${region.name} inside ${region.inside}`));
}

/**
 * Runs in the page: blocks cut off with no way to reach the rest (#507), at most ten, each named with its box. A block
 * is cut when an ancestor that clips without scrolling (`overflow: hidden|clip`) ends before it does, or when it sits
 * in a pinned (fixed or sticky) layer and runs past the screen's edge, where the page scroll cannot bring it in.
 * Deliberate truncation is not a cut: text ending in "…" (`text-overflow`, `line-clamp`), visually hidden text, the
 * skip link waiting for focus. With a dialog open only the topmost one counts; the page under the scrim is inert.
 */
export function clippedBlocksOf(): string[] {
  const root = document.documentElement;
  const screen = { width: root.clientWidth, height: root.clientHeight };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
  const scope = dialogs.at(-1) ?? document.body;
  const nameOf = (element: Element): string => {
    const testId = element.getAttribute('data-testid');
    return `${element.tagName.toLowerCase()}.${element.classList[0] ?? ''}${testId === null ? '' : `[${testId}]`}`;
  };
  const boxOf = (box: DOMRect): string =>
    [box.left, box.top, box.right, box.bottom].map((value) => Math.round(value)).join(',');
  const clips = (value: string): boolean => value === 'hidden' || value === 'clip';
  const isTruncation = (style: CSSStyleDeclaration): boolean =>
    style.textOverflow === 'ellipsis' || (style.webkitLineClamp !== '' && style.webkitLineClamp !== 'none');

  const found: string[] = [];
  for (const element of Array.from(scope.querySelectorAll('*'))) {
    if (element.closest('.tc-sr-only, .shell__skip, svg') !== null) {
      continue;
    }
    const box = element.getBoundingClientRect();
    // Not rendered though laid out: `visibility: hidden`, the content of a closed <details> (content-visibility).
    if (box.width < 1 || box.height < 1 || !element.checkVisibility({ visibilityProperty: true })) {
      continue;
    }
    let isInScroller = false;
    for (
      let node = element.parentElement;
      node !== null && node !== document.body;
      node = node.parentElement
    ) {
      const outer = getComputedStyle(node);
      if (outer.overflowX === 'visible' && outer.overflowY === 'visible') {
        continue;
      }
      if (!clips(outer.overflowX) && !clips(outer.overflowY)) {
        // Inside its own scroller: the rest is a scroll away, and that scroller is judged by scrollRegionsOf.
        isInScroller = true;
        break;
      }
      if (isTruncation(outer)) {
        break;
      }
      const edge = node.getBoundingClientRect();
      const isCutX = clips(outer.overflowX) && (box.left < edge.left - 1 || box.right > edge.right + 1);
      const isCutY = clips(outer.overflowY) && (box.top < edge.top - 1 || box.bottom > edge.bottom + 1);
      if (isCutX || isCutY) {
        found.push(`${nameOf(element)} [${boxOf(box)}] cut by ${nameOf(node)} [${boxOf(edge)}]`);
      }
      break;
    }
    if (isInScroller) {
      continue;
    }
    // A fixed layer never moves, so any part past the edge is out of reach; a sticky one travels with the page until
    // it sticks, so only a part it could never bring in counts: taller than the screen, or out at the side.
    const isPastSide = box.left < -1 || box.right > screen.width + 1;
    const isFixed = (node: Element): boolean => getComputedStyle(node).position === 'fixed';
    const isSticky = (node: Element): boolean => getComputedStyle(node).position === 'sticky';
    const ancestors: Element[] = [];
    for (
      let node: Element | null = element;
      node !== null && node !== document.body;
      node = node.parentElement
    ) {
      ancestors.push(node);
    }
    if (ancestors.some(isFixed) && (isPastSide || box.top < -1 || box.bottom > screen.height + 1)) {
      found.push(`${nameOf(element)} [${boxOf(box)}] fixed past the screen edge`);
    } else if (ancestors.some(isSticky) && (isPastSide || box.height > screen.height + 1)) {
      found.push(`${nameOf(element)} [${boxOf(box)}] pinned and larger than the screen`);
    }
  }
  return found.slice(0, 10);
}
