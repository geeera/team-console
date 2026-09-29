/**
 * Finds raw design values in component CSS: colours, lengths, durations and z-index numbers
 * that should come from the Paper Desk tokens (libs/console/shared/ui/src/tokens/tokens.css).
 * Pure text analysis, no CSS parser: the stylesheets are small and hand-written.
 */
export interface RawValue {
  readonly line: number;
  readonly kind: 'colour' | 'length' | 'duration' | 'z-index';
  readonly value: string;
  readonly declaration: string;
}

// The full CSS Color Module Level 4 named-colour list, minus the keywords that are not raw
// colours (`transparent`, `currentcolor`) — those read the surrounding context, not a fixed value.
const NAMED_COLOURS =
  'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|' +
  'burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|' +
  'darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|' +
  'darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|' +
  'deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|' +
  'ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|' +
  'lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|' +
  'lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|' +
  'lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|' +
  'mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|' +
  'mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|' +
  'olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|' +
  'papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|' +
  'saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|' +
  'snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|' +
  'yellowgreen';

const COLOUR = new RegExp(
  `#[0-9a-f]{3,8}\\b|\\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklch|oklab|color|color-mix)\\(|\\b(?:${NAMED_COLOURS})\\b`,
  'gi',
);
/** A length with a unit, except `0` and the hairline `1px` (borders and outlines). Viewport units size layout, not design. */
const LENGTH = /(?<![\w.-])(-?\d*\.?\d+)(px|rem|em|ch)\b/gi;
const DURATION = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/gi;
const Z_INDEX = /^z-index\s*:\s*(-?\d+)\s*(!important)?$/i;

/** Properties whose numbers are geometry of an SVG or a ratio, not spacing. */
const NUMERIC_PROPERTIES = new Set([
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'line-height',
  'opacity',
  'flex',
  'order',
  'font-weight',
  'aspect-ratio',
  '-webkit-line-clamp',
]);

function stripComments(css: string): string {
  // Keep line breaks so reported line numbers stay right.
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function isTokenDefinition(declaration: string): boolean {
  return /^\s*--[\w-]+\s*:/.test(declaration);
}

function isAtRulePrelude(line: string): boolean {
  return /^\s*@/.test(line);
}

function splitDeclaration(declaration: string): { property: string; value: string } {
  const colon = declaration.indexOf(':');
  if (colon === -1) {
    return { property: '', value: declaration };
  }
  return {
    property: declaration.slice(0, colon).trim().toLowerCase(),
    value: declaration.slice(colon + 1),
  };
}

function allowedLength(value: string, unit: string): boolean {
  const numeric = Number(value);
  return numeric === 0 || (numeric === 1 && unit.toLowerCase() === 'px');
}

export interface InlineStyleBlock {
  /** The 1-based line the block starts on in the source file, so findings can report a real line. */
  readonly startLine: number;
  readonly css: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Pulls declaration blocks out of `style="…"`/`style='…'` template attributes and Angular
 * `styles: [\`…\`]` metadata arrays, so #78's inline styles are checked the same as a `.css` file.
 */
export function extractInlineStyles(source: string): InlineStyleBlock[] {
  const blocks: InlineStyleBlock[] = [];

  for (const match of source.matchAll(/\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/g)) {
    const css = match[1] ?? match[2] ?? '';
    if (css.trim() !== '') {
      blocks.push({ startLine: lineOf(source, match.index), css });
    }
  }

  const stylesArray = /\bstyles\s*:\s*\[([\s\S]*?)\]/g;
  for (const arrayMatch of source.matchAll(stylesArray)) {
    const arrayStart = arrayMatch.index + arrayMatch[0].indexOf('[') + 1;
    const literal = /`([\s\S]*?)`|'([^']*)'|"([^"]*)"/g;
    for (const literalMatch of arrayMatch[1].matchAll(literal)) {
      const css = literalMatch[1] ?? literalMatch[2] ?? literalMatch[3] ?? '';
      if (css.trim() !== '') {
        blocks.push({ startLine: lineOf(source, arrayStart + literalMatch.index), css });
      }
    }
  }

  return blocks;
}

export function findRawValues(
  css: string,
  options: { readonly allowTokenDefinitions?: boolean } = {},
): RawValue[] {
  const found: RawValue[] = [];
  const lines = stripComments(css).split('\n');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    // Breakpoints cannot read custom properties; `@media` preludes are documented in tokens.css.
    if (isAtRulePrelude(line)) {
      return;
    }
    // Hand-written stylesheets put one declaration per line, but a rule may still be inlined.
    for (const segment of line.split(/[;{}]/)) {
      const declaration = segment.trim();
      if (declaration === '' || (options.allowTokenDefinitions && isTokenDefinition(declaration))) {
        continue;
      }
      // Only the value is scanned: `white-space` is not a colour and `line-height` is not a length.
      const { property, value } = splitDeclaration(declaration);

      const zIndex = Z_INDEX.exec(declaration);
      if (zIndex?.[1]) {
        found.push({ line: lineNumber, kind: 'z-index', value: zIndex[1], declaration });
      }

      for (const match of value.matchAll(COLOUR)) {
        found.push({ line: lineNumber, kind: 'colour', value: match[0], declaration });
      }

      for (const match of value.matchAll(DURATION)) {
        if (Number(match[1]) !== 0) {
          found.push({ line: lineNumber, kind: 'duration', value: match[0], declaration });
        }
      }

      if (NUMERIC_PROPERTIES.has(property)) {
        continue;
      }
      for (const match of value.matchAll(LENGTH)) {
        const [raw, number = '', unit = ''] = match;
        if (!allowedLength(number, unit)) {
          found.push({ line: lineNumber, kind: 'length', value: raw, declaration });
        }
      }
    }
  });

  return found;
}
