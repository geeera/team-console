/**
 * Python's whitespace (`str.isspace()`), which the plugin's `str.split()` and `str.strip()` use. It is not JS `\s`:
 * Python adds U+001C–U+001F and U+0085 and does not count U+FEFF, so JS `trim()`/`\s` would drift from the plugin.
 * Every member is in the BMP, so checking UTF-16 code units one by one is exact.
 */
export const PY_WHITESPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

const RUNS = new RegExp(`[${PY_WHITESPACE}]+`, 'g');
const SINGLE = new RegExp(`^[${PY_WHITESPACE}]$`);

export function isPyWhitespace(char: string): boolean {
  return SINGLE.test(char);
}

/** `" ".join(text.split())`: whitespace runs become one space, none at either end. */
export function pyOneLine(text: string): string {
  return text
    .split(RUNS)
    .filter((part) => part !== '')
    .join(' ');
}

/** `text.rstrip()`. */
export function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && isPyWhitespace(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** `text.strip()`. */
export function pyStrip(text: string): string {
  let start = 0;
  while (start < text.length && isPyWhitespace(text.charAt(start))) {
    start += 1;
  }
  return pyRstrip(text.slice(start));
}
