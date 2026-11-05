import type {
  ActorKind,
  AnswerCommand,
  AskCategory,
  AskCommand,
  InboxDto,
  InboxItemDto,
  ItemKind,
  QuestionDto,
  QuestionsDto,
} from '@shared/contracts';
import { ANSWERS, categoryOf, isTeamRecommendation, sectionOf, sectionRank } from '@shared/owner-grammar';
import { withoutInvisibles } from '@shared/plain-text';
import { INBOX_EXCLUDED_FLAGS } from './inbox';
import { questionContextOf } from './question-context';

/**
 * The owner's inbox of a console-tracker project (#434, ADR 0006 decision 12): the GitHub inbox's classification over
 * D1 rows instead of issues. The section is `sectionOf` of `@shared/owner-grammar` over the item's full label set —
 * the plugin's grammar reused, not re-ported — and the order is the same, so both paths yield the same DTOs.
 */

/** The open console ask of an item (an imported ask never reaches the read model, R7). */
export interface TrackerInboxAsk {
  readonly ask: string;
  readonly category: AskCategory;
  readonly commands: readonly AskCommand[];
  readonly recommended: AskCommand | null;
}

/** One open item as D1 holds it, with the full label set (`status:*`, `kind:*`, `tier:*`, `sev:*`, the flags). */
export interface TrackerInboxRow {
  readonly key: string;
  readonly number: number;
  readonly kind: ItemKind;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly createdByKind: ActorKind;
  readonly ask: TrackerInboxAsk | null;
}

/**
 * Rows written by the owner, a job or the system are the team's own; an imported row stays untrusted until it is
 * re-confirmed on the cutover screen (R7), so its body never shapes the card.
 */
const TRUSTED_CREATORS: ReadonlySet<ActorKind> = new Set(['owner', 'job', 'system']);

interface ClassifiedRow {
  readonly row: TrackerInboxRow;
  readonly item: InboxItemDto;
  readonly allowedCommands: readonly AnswerCommand[];
}

function classifiedRows(rows: readonly TrackerInboxRow[]): ClassifiedRow[] {
  const found: ClassifiedRow[] = [];
  for (const row of rows) {
    if (INBOX_EXCLUDED_FLAGS.some((flag) => row.labels.includes(flag))) {
      continue;
    }
    const section = sectionOf(row.labels, row.kind);
    if (section === null) {
      continue;
    }
    const authorTrusted = TRUSTED_CREATORS.has(row.createdByKind);
    const recommended = row.ask?.recommended ?? null;
    found.push({
      row,
      allowedCommands: row.ask?.commands ?? ANSWERS[section],
      item: {
        section,
        number: row.number,
        key: row.key,
        title: withoutInvisibles(row.title),
        // A row has no GitHub page; the console links it by key.
        url: null,
        // A job writes the ask, possibly steered by item text: no bidi override or zero-width run may reshape the
        // question the owner approves (#287, #443).
        ask: row.ask === null ? null : withoutInvisibles(row.ask.ask),
        authorTrusted,
        category: row.ask?.category ?? categoryOf(row.labels),
        // Fails closed: `done` or `override` is not a recommendation a batch could take.
        recommendation: isTeamRecommendation(recommended) ? recommended : null,
        context: authorTrusted ? questionContextOf(row.body) : null,
      },
    });
  }
  return found.sort(
    (a, b) => sectionRank(a.item.section) - sectionRank(b.item.section) || a.item.number - b.item.number,
  );
}

/** The inbox items with the commands each accepts: the open ask's, else the section's (`ANSWERS`). */
export function trackerInboxItemsOf(
  rows: readonly TrackerInboxRow[],
): { readonly item: InboxItemDto; readonly allowedCommands: readonly AnswerCommand[] }[] {
  return classifiedRows(rows).map(({ item, allowedCommands }) => ({ item, allowedCommands }));
}

export function buildTrackerInbox(rows: readonly TrackerInboxRow[]): InboxDto {
  return {
    items: classifiedRows(rows).map(({ item }) => item),
    // Rows have no `team.reviewer_logins`: the owner-only routes are the gate, so there is no setup state.
    setup: false,
    setupUrl: null,
    // TODO(#309 Phase 4): read the pause from `team_state` once it exists; until then a row-backed team is never paused.
    paused: false,
    pausedUrl: null,
  };
}

export function buildTrackerQuestions(rows: readonly TrackerInboxRow[]): QuestionsDto {
  return {
    items: classifiedRows(rows).map(({ row, item, allowedCommands }): QuestionDto => ({
      ...item,
      body: row.body,
      allowedCommands,
    })),
  };
}
