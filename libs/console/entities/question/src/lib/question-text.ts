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
// The plugin's own placeholder words for the reject/no-go side ("owner.py", decision-policy.md): with nothing of
// the team's own reasoning added, an option like this reads as a bare prompt, not a consequence (#291).
const GENERIC_PROMPT =
  /^(?:почему|что поменять|причина,? если что-то не подходит|why|what to change)$/iu;

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
 * `null` when the line marks no option as recommended (#210) — "The team recommends" has nothing to say then, and
 * showing the leftover options or an owner instruction under that label would misrepresent them as advice. The
 * result is plain text for interpolation; any HTML in the ask stays inert text.
 */
export function plainAskOf(ask: string | null): PlainAsk | null {
  if (ask === null) {
    return null;
  }
  const { options } = optionsOf(markdownToPlainText(ask));
  const recommended = options.find((option) => option.isRecommended);
  if (recommended === undefined) {
    return null;
  }
  if (recommended.text !== '') {
    return { kind: 'text', text: sentenceOf(recommended.text) };
  }
  return isAnswerCommand(recommended.command) ? { kind: 'command', command: recommended.command } : null;
}

/**
 * An action item's own instruction (`owner`/`local` sections, "Готово" only, #291): the answer line's lead
 * sentence, without any inline `/command` option — a Готово-only card never offers those, so neither the "·"
 * joiner nor a reject-side prompt belongs in what the card shows. `null` when nothing readable is left. The result
 * is plain text for interpolation, never a recommendation: the console shows it without a "The team recommends"
 * label, since it is the action itself, not advice about it.
 */
export function actionAskOf(ask: string | null): string | null {
  if (ask === null) {
    return null;
  }
  const { lead } = optionsOf(markdownToPlainText(ask));
  return READABLE.test(lead) ? sentenceOf(lead) : null;
}

/** What each answer leads to, for a card whose body has no `## Если одобрить` / `## Если отклонить` (#276). */
export interface AskOutcomes {
  /** The text after `/approve` or `/go`. */
  readonly ifApproved: string | null;
  /** The text after `/reject` or `/no-go`. */
  readonly ifRejected: string | null;
}

const APPROVING: ReadonlySet<string> = new Set(['approve', 'go']);
const REJECTING: ReadonlySet<string> = new Set(['reject', 'no-go']);

/**
 * The answer line's options as outcomes: each option's own words without its `/command` and its "(recommended)"
 * mark; the first option per side counts, and an option with no readable words gives nothing. An option that is
 * only the plugin's placeholder prompt ("почему", "что поменять"…) gives nothing too (#291): without the team's
 * own reasoning added, it reads as a question to answer, not a consequence to show — dropping the outcome beats
 * showing a bare prompt. Plain text for interpolation, never the raw answer line.
 */
export function askOutcomesOf(ask: string | null): AskOutcomes {
  if (ask === null) {
    return { ifApproved: null, ifRejected: null };
  }
  const { options } = optionsOf(markdownToPlainText(ask));
  const textOf = (commands: ReadonlySet<string>): string | null => {
    const text = options.find((option) => commands.has(option.command))?.text ?? '';
    return READABLE.test(text) && !GENERIC_PROMPT.test(text.trim()) ? sentenceOf(text) : null;
  };
  return { ifApproved: textOf(APPROVING), ifRejected: textOf(REJECTING) };
}

/**
 * A question's body for "Details" on screens that do not render markdown: without the answer line (the card shows
 * it as the recommendation) and without markup. Plain text for interpolation; `''` when nothing is left.
 */
export function plainDetailsOf(body: string): string {
  return markdownToPlainText(withoutAskLine(body));
}
