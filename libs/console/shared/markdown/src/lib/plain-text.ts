import { MARKDOWN_MAX_LENGTH } from './rendered-markdown';

// Issue text is hostile input: every pattern below either is anchored and unambiguous, or stops its scan at the
// next marker character, so no input (a line full of `[`, `*` or spaces) makes the work grow faster than linear.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const FENCE = /^(?:```|~~~)/;
const RULE = /^(?:[-*_][ \t]*){3,}$/;
const TABLE_DIVIDER_CHARS = /^[|:\- \t]+$/;
const HEADING = /^#{1,6}(?:[ \t]+|$)/;
const QUOTE = /^(?:>[ \t]?)+/;
const BULLET = /^[-*+][ \t]+/;

// The address may hold one level of parentheses, as `javascript:alert(1)` does.
const IMAGE = /!\[([^[\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const LINK = /\[([^[\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const AUTOLINK = /<((?:https?:|mailto:)[^\s<>]+)>/g;
const CODE = /(`+)([^`\n]+?)\1/g;
const STRONG_STAR = /\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*/g;

const EMPHASIS_STAR = /\*(?=[^\s*])([^*\n]*?[^\s*])\*/g;
// `_` and `__` only at word edges, so snake_case, file_names and `window.__x` stay intact.
const STRONG_UNDERSCORE = /(^|[^\p{L}\p{N}_])__(?=[^\s_])([^_\n]*?[^\s_])__(?![\p{L}\p{N}_])/gmu;
const EMPHASIS_UNDERSCORE = /(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gmu;
const STRIKE = /~~(?=[^\s~])([^~\n]*?[^\s~])~~/g;
const ESCAPABLE = '\\`*_{}[]()#+-.!|~<>';
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~<>])/g;
// An escaped marker is parked on a private-use code point while the inline patterns run, then put back; a
// private-use character already in the text may come back as a marker, which is harmless in plain text.
const PARKED_BASE = 0xe000;
const PARKED = /[\ue000-\ue012]/g;
const BLANK_RUN = /\n{3,}/g;

/** `## Title ##` → `Title`: the closing hashes go only when a space separates them from the words. */
function headingTextOf(line: string): string {
  const text = line.replace(HEADING, '').trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') {
    end -= 1;
  }
  if (end === text.length) {
    return text;
  }
  const before = text.slice(0, end);
  return before === '' || before.trimEnd() !== before ? before.trimEnd() : text;
}

/** A table row `| a | b |` read as `a · b`. */
function tableRowOf(line: string): string {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '')
    .join(' · ');
}

/** One source line without its block markup, or `null` when the line is markup only (a fence, rule, divider). */
function blockLineOf(line: string): string | null {
  const trimmed = line.trim();
  if (FENCE.test(trimmed) || RULE.test(trimmed)) {
    return null;
  }
  if (TABLE_DIVIDER_CHARS.test(trimmed) && trimmed.includes('|') && trimmed.includes('---')) {
    return null;
  }
  if (HEADING.test(trimmed)) {
    return headingTextOf(trimmed);
  }
  const unquoted = trimmed.replace(QUOTE, '');
  if (BULLET.test(unquoted)) {
    const indent = line.slice(0, line.length - line.trimStart().length);
    return `${indent}• ${unquoted.replace(BULLET, '')}`;
  }
  if (unquoted.length > 1 && unquoted.startsWith('|') && unquoted.endsWith('|')) {
    return tableRowOf(unquoted);
  }
  return unquoted === trimmed ? line.trimEnd() : unquoted;
}

/**
 * GitHub markdown as readable plain text, for screens that show issue text without rendering it: HTML comments
 * (the team's `<!-- pt-… -->` markers) go, emphasis, code and heading marks are dropped, a link keeps its words,
 * an image its alt text, a list item becomes `•`, a table row `a · b`. HTML tags are left as they are: the result
 * is for text interpolation only, where a tag is inert, and removing tags by pattern would pose as a sanitiser.
 */
export function markdownToPlainText(text: string): string {
  const source = text.length > MARKDOWN_MAX_LENGTH ? text.slice(0, MARKDOWN_MAX_LENGTH) : text;
  const lines: string[] = [];
  for (const line of source.replace(/\r\n?/g, '\n').replace(COMMENT, '').split('\n')) {
    const plain = blockLineOf(line);
    if (plain !== null) {
      lines.push(plain);
    }
  }
  return lines
    .join('\n')
    .replace(ESCAPE, (_match, char: string) => String.fromCharCode(PARKED_BASE + ESCAPABLE.indexOf(char)))
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(AUTOLINK, '$1')
    .replace(CODE, '$2')
    .replace(STRONG_STAR, '$1')
    .replace(STRONG_UNDERSCORE, '$1$2')
    .replace(EMPHASIS_STAR, '$1')
    .replace(EMPHASIS_UNDERSCORE, '$1$2')
    .replace(STRIKE, '$1')
    .replace(PARKED, (char) => ESCAPABLE.charAt(char.charCodeAt(0) - PARKED_BASE))
    .replace(BLANK_RUN, '\n\n')
    .trim();
}
