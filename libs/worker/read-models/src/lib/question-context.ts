import type { QuestionContextDto } from '@shared/contracts';
import { MARKDOWN_MAX_LENGTH, markdownToPlainText } from '@shared/plain-text';

/**
 * The context a question card shows (#276), read from the fixed `##` sections the team writes into a question's
 * body. Issue text is hostile: the body is cut at GitHub's limit before any scan, every step is linear, and each
 * field comes out as bounded plain text — no markup, no HTML tags, no answer line, no control or bidi characters.
 */

type ContextSlot = 'summary' | 'question' | 'why' | 'ifApproved' | 'ifRejected' | 'costAndRisk';

/**
 * The section headings, ru and en, as matched: NFKC, lower case, single spaces, no trailing colon. A `Map`, so a
 * heading such as `## constructor` never reaches an object's prototype.
 */
export const QUESTION_CONTEXT_HEADINGS: ReadonlyMap<string, ContextSlot> = new Map<string, ContextSlot>([
  ['кратко', 'summary'],
  ['summary', 'summary'],
  ['вопрос', 'question'],
  ['question', 'question'],
  ['почему', 'why'],
  ['why', 'why'],
  ['если одобрить', 'ifApproved'],
  ['if approved', 'ifApproved'],
  ['если отклонить', 'ifRejected'],
  ['if rejected', 'ifRejected'],
  ['цена и риск', 'costAndRisk'],
  ['cost and risk', 'costAndRisk'],
]);

/** Longest text per field, in code points; longer text is cut at a word and ends with an ellipsis. */
export const QUESTION_CONTEXT_LIMITS: Readonly<Record<ContextSlot, number>> = Object.freeze({
  summary: 140,
  question: 800,
  why: 500,
  ifApproved: 500,
  ifRejected: 500,
  costAndRisk: 300,
});

const ELLIPSIS = String.fromCodePoint(0x2026);
// A comment may hide a heading (`<!--\n## Вопрос\n-->`); one left open runs to the end, as markdownToPlainText reads it.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const FENCE = /^ {0,3}(?:```|~~~)/;
// A level-1 or level-2 ATX heading ends a section; `###` and deeper stay part of its text.
const SECTION_BREAK = /^ {0,3}#{1,2}(?:[ \t]|$)/;
const LEVEL_TWO = /^ {0,3}##(?:[ \t]|$)/;
const RULE = /^[-*_]{3,}$/;
// The plugin's answer line and its variants: never shown, it is the plugin's grammar written with «ты».
const ANSWER_LABEL = /^(?:your answer|ваш ответ|твой ответ)[ \t]*:/iu;
const EMPHASIS = /[*_]/gu;
const LEADING_QUOTE = /^[\s>]+/u;
// A tag-like run (`<img …>`, `</b>`, `<!doctype`, `<?x`), up to its `>` or the end of the line. The scan from one `<`
// stops at the next `<`, `>` or newline, so the whole pass stays linear.
const TAG = /<[A-Za-z/!?][^<>\n]*(?:>|$)/gmu;
// C0/C1 controls except tab and newline; zero-width, bidi embedding, override and isolate marks, BOM. ZWJ (U+200D)
// stays: emoji sequences need it. Built from code points, so the source shows exactly which characters are meant.
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
);
const INLINE_SPACE = /[ \t\u{a0}]+/gu;
const BLANK_RUN = /\n{3,}/g;
const ANY_SPACE = /\s+/gu;
const WORD_END = /[\s,;:·—–-]/u;

/** `## Если одобрить:` → `если одобрить`; `null` when the line is not a level-2 heading. */
function headingKeyOf(line: string): string | null {
  if (!LEVEL_TWO.test(line)) {
    return null;
  }
  const text = line.trim().slice(2).normalize('NFKC');
  let end = text.length;
  while (end > 0 && (text[end - 1] === '#' || text[end - 1] === ':' || /\s/u.test(text[end - 1] ?? ''))) {
    end -= 1;
  }
  return text.slice(0, end).replace(ANY_SPACE, ' ').trim().toLowerCase();
}

function isAnswerLine(line: string): boolean {
  return ANSWER_LABEL.test(line.normalize('NFKC').replace(EMPHASIS, '').replace(LEADING_QUOTE, ''));
}

/** Cut to `limit` code points, at a word end when one is in the last fifth, with an ellipsis. */
function bounded(text: string, limit: number): string {
  const points = Array.from(text);
  if (points.length <= limit) {
    return text;
  }
  const floor = Math.floor(limit * 0.8);
  let end = limit - 1;
  while (end > floor && !WORD_END.test(points[end] ?? '')) {
    end -= 1;
  }
  const cut = end > floor ? end : limit - 1;
  return `${points.slice(0, cut).join('').trimEnd()}${ELLIPSIS}`;
}

/** Markdown lines as display text: markup, tags and invisible characters gone, spacing tidied; `null` if empty. */
function plainOf(lines: readonly string[], limit: number, oneLine: boolean): string | null {
  const plain = markdownToPlainText(lines.join('\n'))
    .replace(TAG, '')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => line.replace(INLINE_SPACE, ' ').trim())
    .join('\n')
    .replace(BLANK_RUN, '\n\n')
    .trim();
  const text = oneLine ? plain.replace(ANY_SPACE, ' ') : plain;
  return text === '' ? null : bounded(text, limit);
}

/** The first paragraph of the text, after any leading headings, rules and tables. */
function firstParagraphOf(lines: readonly string[]): string[] {
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (paragraph.length === 0 && (trimmed.startsWith('#') || trimmed.startsWith('|') || RULE.test(trimmed))) {
      continue;
    }
    paragraph.push(line);
  }
  return paragraph;
}

/**
 * A team question's context from its body; `null` when nothing readable is in it. Read only for trusted authors (the
 * caller decides). The first section with a given heading counts, later duplicates are ignored, and a heading inside
 * a fenced block is text. Without any of the sections, `question` is the first paragraph before any other heading and
 * `structured` is `false`. The answer line is dropped wherever it stands.
 */
export function questionContextOf(body: string): QuestionContextDto | null {
  const source = body.length > MARKDOWN_MAX_LENGTH ? body.slice(0, MARKDOWN_MAX_LENGTH) : body;
  const sections = new Map<ContextSlot, string[]>();
  const preamble: string[] = [];
  let current: string[] | null = preamble;
  let inFence = false;
  for (const line of source.replace(/\r\n?/g, '\n').replace(COMMENT, '').split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (!inFence && SECTION_BREAK.test(line)) {
      const slot = QUESTION_CONTEXT_HEADINGS.get(headingKeyOf(line) ?? '');
      if (slot !== undefined && !sections.has(slot)) {
        current = [];
        sections.set(slot, current);
      } else {
        current = null;
      }
      continue;
    }
    if (current !== null && !isAnswerLine(line)) {
      current.push(line);
    }
  }
  const field = (slot: ContextSlot): string | null => {
    const lines = sections.get(slot);
    return lines === undefined ? null : plainOf(lines, QUESTION_CONTEXT_LIMITS[slot], slot === 'summary');
  };
  const structured = sections.size > 0;
  const context: QuestionContextDto = {
    summary: field('summary'),
    question: structured
      ? field('question')
      : plainOf(firstParagraphOf(preamble), QUESTION_CONTEXT_LIMITS.question, false),
    why: field('why'),
    ifApproved: field('ifApproved'),
    ifRejected: field('ifRejected'),
    costAndRisk: field('costAndRisk'),
    structured,
  };
  const texts = [context.summary, context.question, context.why, context.ifApproved, context.ifRejected];
  return [...texts, context.costAndRisk].every((text) => text === null) ? null : context;
}
