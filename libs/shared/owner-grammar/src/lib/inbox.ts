import { PY_WHITESPACE, pyStrip } from './python-text';

/**
 * The owner's inbox order and answer line, as the plugin's `inbox.ORDER` and `owner.ask_of` define them (#35's read
 * models sort and label items with these; the golden tests in @worker/read-models compare against the plugin).
 */

/** `inbox.ORDER`: `setup` and `paused` come from the repository's state, the rest are issue sections. */
export const INBOX_ORDER = ['setup', 'paused', 'release', 'design', 'question', 'owner', 'local'] as const;

export type InboxSection = (typeof INBOX_ORDER)[number];

/** Position in `INBOX_ORDER`; the plugin sorts an unknown section last (`order.get(key, 99)`). */
export function sectionRank(section: string): number {
  const index = (INBOX_ORDER as readonly string[]).indexOf(section);
  return index === -1 ? 99 : index;
}

// `owner._ASK` with re.MULTILINE: `^` at the start or after "\n"; Python's `.` is anything but "\n" (it matches "\r"
// and U+2028, where JavaScript's `.` and `m` flag would stop) and its `\s` is `str.isspace()`.
const ASK_LINE = new RegExp(
  `(?:^|(?<=\\n))\\*\\*(?:Your answer|Ваш ответ|Твой ответ):\\*\\*[${PY_WHITESPACE}]*([^\\n]+)`,
  'u',
);

/**
 * `owner.ask_of`: the answer line of a question ("**Your answer:** /approve … · /reject …"), stripped; `null` when
 * the body has none, `""` when the line is empty (as the plugin returns). Untrusted issue text, kept as plain text.
 */
export function askOf(body: string | null | undefined): string | null {
  const line = ASK_LINE.exec(body ?? '')?.[1];
  return line === undefined ? null : pyStrip(line);
}
