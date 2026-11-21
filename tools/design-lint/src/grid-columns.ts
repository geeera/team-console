/**
 * Finds `display: grid` rules without an explicit column template (#839). An implicit `auto` track sizes to its
 * content, so a long word or a wide child overflows the panel (#775, #761, #281). A rule passes with
 * `grid-template-columns`, `grid-template` or the `grid` shorthand; a rule that really wants implicit columns says so
 * with a `grid-columns-ok: <why>` comment inside it.
 */
export interface GridWithoutColumns {
  readonly line: number;
  readonly selector: string;
}

const LEAF_RULE = /([^{}]*)\{([^{}]*)\}/g;
const DISPLAY_GRID = /(?:^|[;\s])display\s*:\s*(?:inline-)?grid\s*(?:!important\s*)?(?:;|$)/i;
const COLUMNS = /(?:^|[;\s])(?:grid-template-columns|grid-template|grid)\s*:/i;
const ANNOTATION = /grid-columns-ok\s*:/i;

function blankComments(css: string): string {
  // Same length, so offsets map back to the original text (which still holds the annotations).
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

export function findGridsWithoutColumns(css: string): GridWithoutColumns[] {
  const found: GridWithoutColumns[] = [];
  // A bare declaration list (a `style="…"` attribute) has no rule around it.
  const source = css.includes('{') ? css : `style{${css}}`;
  const blanked = blankComments(source);
  for (const match of blanked.matchAll(LEAF_RULE)) {
    const prelude = match[1] ?? '';
    const body = match[2] ?? '';
    if (!DISPLAY_GRID.test(body) || COLUMNS.test(body)) {
      continue;
    }
    const bodyStart = match.index + prelude.length + 1;
    if (ANNOTATION.test(source.slice(bodyStart, bodyStart + body.length))) {
      continue;
    }
    const ruleStart = match.index + prelude.search(/\S|$/);
    found.push({ line: source.slice(0, ruleStart).split('\n').length, selector: prelude.trim() });
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
