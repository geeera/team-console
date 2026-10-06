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
const COMMAND_WORD = /(?<![A-Za-z0-9_/-])\/(approve|reject|no-go|go)(?![A-Za-z0-9_-])/;
const RECOMMENDS = ['recommend', 'рекоменду'] as const;

/**
 * The team's recommendation in an answer line (`askOf`): its first command word, but only when the line says it
 * recommends one ("recommend…", "рекоменду…", any case). The decision policy puts the recommendation first.
 */
export function recommendationOf(ask: string | null): TeamRecommendation | null {
  if (ask === null) {
    return null;
  }
  const lower = ask.toLowerCase();
  if (!RECOMMENDS.some((word) => lower.includes(word))) {
    return null;
  }
  const command = COMMAND_WORD.exec(ask)?.[1];
  return isTeamRecommendation(command) ? command : null;
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
