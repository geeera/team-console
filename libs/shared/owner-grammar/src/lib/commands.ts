import { PY_WHITESPACE, pyStrip } from './python-text';

/**
 * How the plugin reads owner commands out of a comment (`ptlib/commands.py`, `command_lines` and `is_team_note`):
 * a command is the first token of a line of the owner's own prose — not inside a fenced block, a code span, a
 * blockquote or an HTML comment, indented at most three spaces (or NBSPs) or one tab.
 *
 * Porting notes, each proven by the golden fixtures: Python's `re.IGNORECASE` also matches U+0130/U+0131 for `i`
 * and U+017F for `s`, so the names are spelled out as character classes instead of the `i` flag; Python's `\w`
 * is `[\p{L}\p{N}_]`; Python's `.` matches U+2028/U+2029 (the `s` flag here); masking works per UTF-16 code unit
 * so offsets into the masked line stay offsets into the original.
 */

/** Every command the plugin reads from a comment (`commands.COMMANDS`); `done` is a marker, not a command. */
export const OWNER_COMMANDS = ['approve', 'reject', 'go', 'no-go', 'resume', 'override'] as const;
export type OwnerCommand = (typeof OWNER_COMMANDS)[number];

const CASE_VARIANTS: Readonly<Record<string, string>> = { i: 'iIİı', s: 'sSſ' };

function caseInsensitive(name: string): string {
  return [...name]
    .map((char) => {
      if (char === '-') {
        return '-';
      }
      return `[${CASE_VARIANTS[char] ?? `${char}${char.toUpperCase()}`}]`;
    })
    .join('');
}

const NAMES = OWNER_COMMANDS.map(caseInsensitive).join('|');
// Up to three spaces (or NBSPs), or one tab: more makes an indented code block in Markdown.
const INDENT = '(?:[ \\u00a0]{0,3}|\\t)';
const LINE = new RegExp(`^${INDENT}/(${NAMES})(?![\\p{L}\\p{N}_-])[ \\t:]*(.*)$`, 'su');
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s;
const QUOTE = new RegExp(`^${INDENT}>`);
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// A code span: a run of backticks up to the same run, within one paragraph (never across a blank line).
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])+?(?<!`)\1(?!`)/g;

/** Headers the team's agents start their issue comments with (the plugin's `AGENT_NOTE_ROLES`). */
export const AGENT_NOTE_ROLES = [
  'Architect',
  'PM',
  'Product manager',
  'UX',
  'UI',
  'Designer',
  'Design',
  'Developer',
  'Dev',
  'QA',
  'Reviewer',
  'Review',
  'Security',
  'DevOps',
  'Analyst',
  'Scribe',
  'Team',
] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AGENT_NOTE = new RegExp(
  `^[${PY_WHITESPACE}]*(?:#{1,6}[ \\t]+)?\\*\\*(?:${AGENT_NOTE_ROLES.map(escapeRegExp).join('|')})` +
    `(?![\\p{L}\\p{N}_])[^\\n]*?\\*\\*`,
  'u',
);
const SCRIPT_MARKER = new RegExp(`^[${PY_WHITESPACE}]*<!-- pt-`);
const MASK = '\u0000';

function mask(text: string): string {
  return text.replace(/[^\n]/g, MASK);
}

/** A comment the team wrote: it starts with an agent note header or a script marker. */
export function isTeamNote(body: string): boolean {
  return AGENT_NOTE.test(body) || SCRIPT_MARKER.test(body);
}

/**
 * The body's lines, and the same lines with everything that is not the owner's own prose (fences, HTML comments,
 * code spans) masked, offsets kept.
 */
function linesOf(body: string): { readonly lines: string[]; readonly masked: string[] } {
  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const maskedLines: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    const marker = match?.[1] ?? '';
    const info = match?.[2] ?? '';
    if (fence === null && match !== null && !(marker.startsWith('`') && info.includes('`'))) {
      fence = marker;
      maskedLines.push(mask(line));
    } else if (fence !== null) {
      if (match !== null && marker[0] === fence[0] && marker.length >= fence.length && pyStrip(info) === '') {
        fence = null;
      }
      maskedLines.push(mask(line));
    } else {
      maskedLines.push(line);
    }
  }
  const masked = maskedLines
    .join('\n')
    .replace(HTML_COMMENT, (found) => mask(found))
    .replace(CODE_SPAN, (found) => mask(found));
  return { lines, masked: masked.split('\n') };
}

export interface CommandLine {
  /** Lower-cased as the plugin does; a case-folded look-alike (`/reſume`) stays as written. */
  readonly command: string;
  readonly text: string;
}

/**
 * Every owner command line of `body`, in order (`commands.command_lines`). `sameAccount`: the agents write as the
 * owner's login, so comments that start like a team note hold no command; unknown means `true`.
 */
export function commandLines(body: string, sameAccount = true): CommandLine[] {
  if (sameAccount && isTeamNote(body)) {
    return [];
  }
  const { lines, masked } = linesOf(body);
  const found: CommandLine[] = [];
  masked.forEach((line, index) => {
    if (QUOTE.test(line)) {
      return;
    }
    const match = LINE.exec(line);
    if (match === null) {
      return;
    }
    const name = match[1] ?? '';
    const rest = match[2] ?? '';
    const original = lines[index] ?? '';
    found.push({ command: name.toLowerCase(), text: pyStrip(original.slice(line.length - rest.length)) });
  });
  return found;
}
