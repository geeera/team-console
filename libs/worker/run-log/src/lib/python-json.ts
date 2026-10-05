/**
 * Python's `json.dumps(value, sort_keys=…)` with its defaults (`ensure_ascii=True`, separators `", "` and `": "`),
 * for the JSON the plugin embeds in run-log markers. The console's records must read byte for byte like the
 * plugin's, so this is not `JSON.stringify`: Python escapes every non-ASCII code unit as `\uXXXX` and spaces its
 * separators.
 */

export type PyJson =
  string | number | boolean | null | readonly PyJson[] | { readonly [key: string]: PyJson };

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

function pyString(value: string): string {
  let out = '"';
  // Per UTF-16 code unit, as CPython's ensure_ascii does: an astral character becomes its surrogate pair.
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const code = value.charCodeAt(index);
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      out += short;
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

function pyNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('only finite numbers are written to the run log');
  }
  if (!Number.isInteger(value)) {
    throw new Error('the run-log records carry integers only');
  }
  return String(value);
}

export function pyJsonDumps(value: PyJson, sortKeys = false): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return pyString(value);
  }
  if (typeof value === 'number') {
    return pyNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: PyJson) => pyJsonDumps(item, sortKeys)).join(', ')}]`;
  }
  const record = value as { readonly [key: string]: PyJson };
  // Python sorts by code point; for the BMP that is UTF-16 order, which is what `<` compares.
  const keys = sortKeys
    ? Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : Object.keys(record);
  const members = keys.map((key) => `${pyString(key)}: ${pyJsonDumps(record[key] ?? null, sortKeys)}`);
  return `{${members.join(', ')}}`;
}
