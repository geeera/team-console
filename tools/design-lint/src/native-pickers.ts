/**
 * Finds native date and time inputs in console templates and code (#307): their pickers are the browser's and the
 * OS's — other colours, fonts and buttons, different on iOS — so the console uses the kit's `DatePicker` instead.
 */
export interface NativePicker {
  readonly line: number;
  readonly type: string;
  readonly snippet: string;
}

const PICKER_TYPES = 'date|time|datetime-local|month|week';

const PATTERNS: readonly RegExp[] = [
  // <input type="date"> and <input … type='time' …>
  new RegExp(`<input\\b[^>]*?\\btype\\s*=\\s*(["'])\\s*(${PICKER_TYPES})\\s*\\1`, 'gi'),
  // [type]="'date'" and [attr.type]="'date'"
  new RegExp(`\\[(?:attr\\.)?type\\]\\s*=\\s*(["'])\\s*['"\`](${PICKER_TYPES})['"\`]\\s*\\1`, 'gi'),
  // input.type = 'date' and setAttribute('type', 'date')
  new RegExp(`\\.type\\s*=\\s*(['"\`])(${PICKER_TYPES})\\1`, 'gi'),
  new RegExp(`setAttribute\\(\\s*['"\`]type['"\`]\\s*,\\s*(['"\`])(${PICKER_TYPES})\\1`, 'gi'),
];

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

export function findNativePickers(source: string): NativePicker[] {
  const found: NativePicker[] = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      found.push({
        line: lineOf(source, match.index),
        type: (match[2] ?? '').toLowerCase(),
        snippet: match[0].replace(/\s+/g, ' ').slice(0, 80),
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}
