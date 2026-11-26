/**
 * Finds `display: grid` rules without an explicit column template (#839). An implicit `auto` track sizes to its
 * content, so a long word or a wide child overflows the panel (#775, #761, #281). A rule passes with
 * `grid-template-columns`, `grid-template` or the `grid` shorthand; a rule that really wants implicit columns says so
 * with a `grid-columns-ok: <why>` comment inside it. Nested rules (native CSS nesting, `@media` inside a rule) are
 * judged on their own declarations (#898).
 */
export interface GridWithoutColumns {
  readonly line: number;
  readonly selector: string;
}

const DISPLAY_GRID = /(?:^|[;\s])display\s*:\s*(?:inline-)?grid\s*(?:!important\s*)?(?:;|$)/i;
const COLUMNS = /(?:^|[;\s])(?:grid-template-columns|grid-template|grid)\s*:/i;
const ANNOTATION = /grid-columns-ok\s*:/i;

function blankComments(css: string): string {
  // Same length, so offsets map back to the original text (which still holds the annotations).
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

interface RuleBlock {
  readonly prelude: string;
  /** Offset of the first character of the prelude in the source. */
  readonly preludeStart: number;
  /** The rule's own declarations: its body minus every nested block, as offsets into the source. */
  readonly ownRanges: Array<[number, number]>;
}

interface Frame {
  readonly block: RuleBlock;
  ownStart: number;
  /** Start of the text after the last `;` or closed block: the prelude of a block opening next. */
  segmentStart: number;
}

function readRuleBlocks(blanked: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  // Frame 0 is the top level; it is never judged because it is not returned in `blocks`.
  const stack: Frame[] = [
    { block: { prelude: '', preludeStart: 0, ownRanges: [] }, ownStart: 0, segmentStart: 0 },
  ];
  for (let index = 0; index < blanked.length; index += 1) {
    const char = blanked[index];
    const top = stack[stack.length - 1];
    if (top === undefined) {
      break;
    }
    if (char === ';') {
      top.segmentStart = index + 1;
    } else if (char === '{') {
      // Blanked comments before the selector belong to the parent: that is where an annotation may sit.
      const preludeStart = top.segmentStart + blanked.slice(top.segmentStart, index).search(/\S|$/);
      top.block.ownRanges.push([top.ownStart, preludeStart]);
      const block: RuleBlock = { prelude: blanked.slice(preludeStart, index), preludeStart, ownRanges: [] };
      blocks.push(block);
      stack.push({ block, ownStart: index + 1, segmentStart: index + 1 });
    } else if (char === '}' && stack.length > 1) {
      top.block.ownRanges.push([top.ownStart, index]);
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent !== undefined) {
        parent.ownStart = index + 1;
        parent.segmentStart = index + 1;
      }
    }
  }
  return blocks;
}

export function findGridsWithoutColumns(css: string): GridWithoutColumns[] {
  const found: GridWithoutColumns[] = [];
  // A bare declaration list (a `style="…"` attribute) has no rule around it.
  const source = css.includes('{') ? css : `style{${css}}`;
  const blanked = blankComments(source);
  const ownText = (block: RuleBlock, text: string): string =>
    block.ownRanges.map(([from, to]) => text.slice(from, to)).join(';');
  for (const block of readRuleBlocks(blanked)) {
    const body = ownText(block, blanked);
    if (!DISPLAY_GRID.test(body) || COLUMNS.test(body) || ANNOTATION.test(ownText(block, source))) {
      continue;
    }
    found.push({
      line: source.slice(0, block.preludeStart).split('\n').length,
      selector: block.prelude.trim(),
    });
  }
  return found;
}

/** Files whose count of grids without columns is above what the baseline allows (a file not listed allows none). */
export function gridFilesOverBaseline(
  counts: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): string[] {
  return Object.entries(counts)
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(([file]) => file);
}

/**
 * Files whose baseline count is higher than in the base branch's baseline (a file the base does not list had none).
 * The baseline may only shrink: an exception is paid down, never added (#898).
 */
export function gridBaselineRaises(
  baseline: Readonly<Record<string, number>>,
  previous: Readonly<Record<string, number>>,
): string[] {
  return Object.entries(baseline)
    .filter(([file, count]) => count > (previous[file] ?? 0))
    .map(([file]) => file);
}
