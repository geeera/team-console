import type { AnswerCommand } from '@shared/contracts';
import { markdownToPlainText } from '@console/shared/markdown';
import { isAnswerCommand, withoutAskLine } from '@shared/owner-grammar';

/**
 * What "The team recommends" says in words: the recommended option's own text, or — when that option is a bare
 * command such as `/go (recommended)` — the command, which the card names with its button label.
 */
export type PlainAsk =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'command'; readonly command: AnswerCommand };

// A command word where an option starts: at the start, or after a space, `·`, `,`, `;` or `(`; never inside a URL.
const COMMAND = /(?<![^\s·,;(])\/([a-z][a-z-]*)(?![\p{L}\p{N}/])/gu;
const PARENTHESISED = /\(([^()]*)\)/g;
const RECOMMENDATION_MARK = /^(?:recommended|рекомендую|рекомендуем|рекомендуется|советую|советуем)$/iu;
const LEADING_JOINER = /^[\s—–:-]+/u;
const TRAILING_SEPARATORS = new Set([' ', '·', ',', ';']);
const ENGLISH_TO = /^to\s+/iu;
const SPACES = /\s+/gu;
const READABLE = /[\p{L}\p{N}]/u;

interface AskOption {
  readonly command: string;
  readonly text: string;
  readonly isRecommended: boolean;
}

/** `(free, recommended)` → `(free)`; `(рекомендую)` → nothing. Tells whether a mark was there. */
function withoutRecommendationMark(text: string): { readonly text: string; readonly isRecommended: boolean } {
  let isRecommended = false;
  const cleaned = text.replace(PARENTHESISED, (whole, inner: string) => {
    const parts = inner.split(',').map((part) => part.trim());
    const kept = parts.filter((part) => !RECOMMENDATION_MARK.test(part));
    if (kept.length === parts.length) {
      return whole;
    }
    isRecommended = true;
    return kept.length === 0 ? '' : `(${kept.join(', ')})`;
  });
  return { text: cleaned, isRecommended };
}

// A loop, not `/[\s·,;]+$/`: that pattern rescans every run of separators that is not at the end.
function withoutTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING_SEPARATORS.has(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

function tidy(text: string): string {
  return withoutTrailingSeparators(text.replace(SPACES, ' ')).replace(LEADING_JOINER, '').trim();
}

function sentenceOf(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function optionsOf(ask: string): { readonly lead: string; readonly options: readonly AskOption[] } {
  const matches = Array.from(ask.matchAll(COMMAND));
  const lead = ask.slice(0, matches[0]?.index ?? ask.length);
  const options = matches.map((match, i) => {
    const start = match.index + match[0].length;
    const end = matches[i + 1]?.index ?? ask.length;
    const marked = withoutRecommendationMark(ask.slice(start, end));
    return {
      command: match[1] ?? '',
      text: tidy(marked.text).replace(ENGLISH_TO, ''),
      isRecommended: marked.isRecommended,
    };
  });
  return { lead: tidy(lead), options };
}

/**
 * An issue's answer line (`askOf`) as a plain sentence for "The team recommends": the recommended option's text
 * without its `/command`, its "(recommended)" mark and the other options, which the answer buttons already offer.
 * With no recommended option it is the line without command words; `null` when nothing readable is left. The
 * result is plain text for interpolation; any HTML in the ask stays inert text.
 */
export function plainAskOf(ask: string | null): PlainAsk | null {
  if (ask === null) {
    return null;
  }
  const { lead, options } = optionsOf(markdownToPlainText(ask));
  const recommended = options.find((option) => option.isRecommended);
  if (recommended !== undefined) {
    if (recommended.text !== '') {
      return { kind: 'text', text: sentenceOf(recommended.text) };
    }
    if (isAnswerCommand(recommended.command)) {
      return { kind: 'command', command: recommended.command };
    }
  }
  const words = [lead, ...options.map((option) => option.text)].filter((text) => text !== '').join(' · ');
  const text = options.length === 0 ? withoutRecommendationMark(words).text.trim() : words;
  return READABLE.test(text) ? { kind: 'text', text: sentenceOf(text) } : null;
}

/**
 * A question's body for "Details" on screens that do not render markdown: without the answer line (the card shows
 * it as the recommendation) and without markup. Plain text for interpolation; `''` when nothing is left.
 */
export function plainDetailsOf(body: string): string {
  return markdownToPlainText(withoutAskLine(body));
}
