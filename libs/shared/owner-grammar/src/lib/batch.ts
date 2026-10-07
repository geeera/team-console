import type { BatchLeftOutReason, OwnerCategory, Section, TeamRecommendation } from '@shared/contracts';

/**
 * What a batch of approvals may contain (#220, architect note on #29 §4). One rule for the read models, the client's
 * list and the server's re-check, so all three agree. Not a plugin function: the plugin writes the `owner:*` label
 * and the answer line (`backlog ask`), and the golden fixtures of `@worker/read-models` feed its own ask lines here.
 */

/** The plugin's `owner.CATEGORIES`, in its order: the only reasons the team asks the owner. */
export const OWNER_CATEGORIES: readonly OwnerCategory[] = Object.freeze([
  'money',
  'scope',
  'release',
  'access',
  'legal',
  'design',
]);

export const TEAM_RECOMMENDATIONS: readonly TeamRecommendation[] = Object.freeze([
  'approve',
  'reject',
  'go',
  'no-go',
]);

export const BATCH_LEFT_OUT_REASONS: readonly BatchLeftOutReason[] = Object.freeze([
  'untrusted',
  'money',
  'release',
  'legal',
  'access',
  'design',
  'uncategorised',
  'reject',
  'no-recommendation',
]);

const OWNER_PREFIX = 'owner:';

export function isOwnerCategory(value: unknown): value is OwnerCategory {
  return typeof value === 'string' && (OWNER_CATEGORIES as readonly string[]).includes(value);
}

export function isTeamRecommendation(value: unknown): value is TeamRecommendation {
  return typeof value === 'string' && (TEAM_RECOMMENDATIONS as readonly string[]).includes(value);
}

export function isBatchLeftOutReason(value: unknown): value is BatchLeftOutReason {
  return typeof value === 'string' && (BATCH_LEFT_OUT_REASONS as readonly string[]).includes(value);
}

/**
 * The owner decision an issue is about, from its `owner:<category>` labels; `null` without a known one. The plugin
 * sets exactly one; should someone add a second by hand, any category but `scope` wins, so a batch never takes a
 * question that is also about money, a release, legal, access or a design.
 */
export function categoryOf(labels: readonly string[]): OwnerCategory | null {
  const found = labels
    .filter((name) => name.startsWith(OWNER_PREFIX))
    .map((name) => name.slice(OWNER_PREFIX.length))
    .filter(isOwnerCategory);
  return found.find((category) => category !== 'scope') ?? found[0] ?? null;
}

// A command word as the plugin's ask lines spell it: `/approve`, `/reject`, `/go`, `/no-go`, standing on its own
// (not inside a path or a longer word). ASCII word characters only, so Python and JavaScript agree on the edges.
const COMMAND_WORD = /(?<![A-Za-z0-9_/-])\/(approve|reject|no-go|go)(?![A-Za-z0-9_-])/g;
// The separators the plugin's ask lines put between options ("/approve … · /reject …"), outside parentheses.
const OPTION_SEPARATORS: ReadonlySet<string> = new Set(['·', ',', ';', '|']);
// The only accepted marker, as the plugin writes it ("(recommended)", "(free, recommended)"; owner.py,
// decision-policy.md): a parenthesised group whose last comma-separated part is exactly one of these words.
const MARKER_WORDS: ReadonlySet<string> = new Set(['recommended', 'рекомендую', 'рекомендуем']);
const PARENTHESISED = /\(([^()]*)\)/g;
const CODE_SPAN = /`([^`]*)`/g;
const STARTS_WITH_COMMAND = /^\/(?:approve|reject|no-go|go)(?![A-Za-z0-9_-])/;
const RECOMMEND_WORD = /recommend|рекоменд/g;
// Defence in depth behind the allowlist: a line that negates a recommendation anywhere recommends nothing.
const NEGATED =
  /(?:not|n['’]t|never|no)[\s-]*recommend|recommend\w*\s+against|не[\s-]*рекоменд|нет,?\s*рекоменд/;
const FORMAT_CHARACTER = /\p{Cf}/u;
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

function commandsOf(text: string): string[] {
  return [...text.matchAll(COMMAND_WORD)].map((match) => match[1] ?? '');
}

/** A word that mixes Latin and Cyrillic letters ("nоt" with a Cyrillic о) is a disguise, never prose. */
function hasMixedScriptWord(text: string): boolean {
  return [...text.matchAll(WORD)].some(([word]) => LATIN.test(word) && CYRILLIC.test(word));
}

/** Code spans are not prose: a command span (`` `/reject why` ``) keeps its text, any other span is dropped. */
function withoutCodeSpans(text: string): string {
  return text.replace(CODE_SPAN, (_span, inner: string) =>
    STARTS_WITH_COMMAND.test(inner.trim()) ? inner : ' ',
  );
}

/** The pieces between separators outside parentheses; a piece with no command word joins the option before it. */
function optionsOf(text: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && OPTION_SEPARATORS.has(char)) {
      pieces.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  pieces.push(current);
  const options: string[] = [];
  for (const piece of pieces) {
    if (commandsOf(piece).length > 0 || options.length === 0) {
      options.push(piece);
    } else {
      options[options.length - 1] += ` ${piece}`;
    }
  }
  return options;
}

function markersIn(text: string): number {
  return [...text.matchAll(PARENTHESISED)].filter(([, inner]) => {
    const last = (inner ?? '').split(',').pop()?.trim() ?? '';
    return MARKER_WORDS.has(last);
  }).length;
}

/**
 * The team's recommendation in an answer line (`askOf`), as an allowlist that fails closed (#233 SECURITY review).
 * The line is NFKC-normalised and refused outright if it holds a format character (`\p{Cf}`: zero-width space, soft
 * hyphen…) or a word that mixes Latin and Cyrillic. Code spans other than a command are dropped. A recommendation is
 * only the plugin's marker — a parenthesised group whose last part is exactly "recommended", "рекомендую" or
 * "рекомендуем" (any case) — and it counts only when the line holds exactly one such marker, it sits in exactly one
 * option, that option names exactly one command, no other "recommend…"/"рекоменд…" appears on the line, and nothing
 * negates a recommendation. Anything else is `null`: the owner answers it one by one.
 */
export function recommendationOf(ask: string | null): TeamRecommendation | null {
  if (ask === null) {
    return null;
  }
  const normalised = ask.normalize('NFKC');
  if (FORMAT_CHARACTER.test(normalised) || hasMixedScriptWord(normalised)) {
    return null;
  }
  const text = withoutCodeSpans(normalised).toLowerCase();
  if (NEGATED.test(text)) {
    return null;
  }
  const markers = markersIn(text);
  if (markers !== 1 || [...text.matchAll(RECOMMEND_WORD)].length !== 1) {
    return null;
  }
  const marked = optionsOf(text).filter((option) => markersIn(option) === 1);
  if (marked.length !== 1) {
    return null;
  }
  const commands = new Set(commandsOf(marked[0] ?? ''));
  const [command] = commands;
  return commands.size === 1 && isTeamRecommendation(command) ? command : null;
}

/** The facts the batch rule looks at; the read models' `InboxItemDto` carries all of them. */
export interface BatchFacts {
  readonly section: Section;
  readonly category: OwnerCategory | null;
  readonly recommendation: TeamRecommendation | null;
  readonly authorTrusted: boolean;
}

/**
 * `batch`: a question about scope, from a trusted author, that the team recommends approving. `left-out`: a
 * decision the owner answers one by one, with the reason. `not-asked`: an action item (`owner`, `local`), which
 * carries no recommendation — the batch neither lists nor counts it.
 */
export type BatchVerdict =
  | { readonly kind: 'batch' }
  | { readonly kind: 'left-out'; readonly reason: BatchLeftOutReason }
  | { readonly kind: 'not-asked' };

function leftOut(reason: BatchLeftOutReason): BatchVerdict {
  return { kind: 'left-out', reason };
}

/**
 * Whether an item may be approved in a batch. The order of the checks decides the reason shown: who wrote it first
 * (an outsider's text decides nothing), then what kind of decision it is, then what the team recommends.
 */
export function batchVerdictOf(facts: BatchFacts): BatchVerdict {
  if (facts.section === 'owner' || facts.section === 'local') {
    return { kind: 'not-asked' };
  }
  if (!facts.authorTrusted) {
    return leftOut('untrusted');
  }
  if (facts.section === 'release' || facts.section === 'design') {
    return leftOut(facts.section);
  }
  if (facts.category === null) {
    return leftOut('uncategorised');
  }
  if (facts.category !== 'scope') {
    return leftOut(facts.category);
  }
  if (facts.recommendation === 'reject' || facts.recommendation === 'no-go') {
    return leftOut('reject');
  }
  return facts.recommendation === 'approve' ? { kind: 'batch' } : leftOut('no-recommendation');
}
