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
        isPinned = region.getBoundingClientRect().height <= viewportHeight + 1;
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
