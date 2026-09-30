/**
 * The owner's inbox as the product-team plugin classifies it (`scripts/ptlib/inbox.py`, `brief.py`, `owner.py`,
 * vendored in `.claude/product-team`). A port, not a variation: the golden tests in `@worker/read-models` compare
 * it with the plugin's own output, so a change here must follow a change there.
 */

/** `inbox.ORDER`: the order the owner sees the sections in. */
export const SECTION_ORDER = ['setup', 'paused', 'release', 'design', 'question', 'owner', 'local'] as const;

export type Section = (typeof SECTION_ORDER)[number];

/** Sections an issue can land in; `setup` and `paused` come from the repository's state, not from an issue. */
export type ItemSection = Exclude<Section, 'setup' | 'paused'>;

/** Every command an owner answer can carry (`brief.ANSWERABLE`). */
export type OwnerCommand = 'approve' | 'reject' | 'go' | 'no-go' | 'override' | 'done';

/** `brief.ANSWERS`: what each kind of item is answered with. Action items are reported done, never approved. */
export const ANSWERS: Readonly<Record<ItemSection, readonly OwnerCommand[]>> = Object.freeze({
  question: Object.freeze(['approve', 'reject'] as const),
  design: Object.freeze(['approve', 'reject'] as const),
  release: Object.freeze(['go', 'no-go', 'override'] as const),
  owner: Object.freeze(['done'] as const),
  local: Object.freeze(['done'] as const),
});

/** The issue's kind as the plugin's `slim()` reads it: the first `kind:*` label, without the prefix. */
export function kindOf(labels: readonly string[]): string | null {
  const label = labels.find((name) => name.startsWith('kind:'));
  return label === undefined ? null : label.slice('kind:'.length);
}

/** `inbox.classify`: the section an open issue belongs to, or `null` when it does not need the owner. */
export function sectionOf(labels: readonly string[], kind: string | null): ItemSection | null {
  const has = new Set(labels);
  if (has.has('team:demo')) {
    return 'release';
  }
  if (has.has('design:awaiting-approval')) {
    return 'design';
  }
  if (has.has('needs:owner') && kind !== 'question') {
    return 'owner';
  }
  if (kind === 'question') {
    return 'question';
  }
  if (has.has('needs:local')) {
    return 'local';
  }
  return null;
}

/** Position of a section in `SECTION_ORDER`; the plugin sorts unknown sections last (99). */
export function sectionRank(section: string): number {
  const index = (SECTION_ORDER as readonly string[]).indexOf(section);
  return index === -1 ? 99 : index;
}

// `owner._ASK` with re.MULTILINE: `^` at the start or after "\n", `.` is anything but "\n" (Python's `.` does
// match "\r" and U+2028, so JavaScript's `.` and the `m` flag would stop earlier than the plugin does).
const ASK_LINE = /(?:^|(?<=\n))\*\*(?:Your answer|Ваш ответ|Твой ответ):\*\*\s*([^\n]+)/u;

/**
 * `owner.ask_of`: the answer line of a question ("**Your answer:** /approve … · /reject …"), trimmed; `null`
 * when the body has none. The text is untrusted issue content and is returned as plain text.
 */
export function askOf(body: string | null | undefined): string | null {
  const match = ASK_LINE.exec(body ?? '');
  const line = match?.[1];
  return line === undefined ? null : line.trim();
}
