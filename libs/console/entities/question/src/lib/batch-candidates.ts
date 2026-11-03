import type { BatchLeftOutReason } from '@shared/contracts';
import { batchVerdictOf } from '@shared/owner-grammar';
import type { QuestionItem } from './question.model';

/** An item the owner answers one by one, and why it is not in the batch. */
export interface BatchLeftOut {
  readonly item: QuestionItem;
  readonly reason: BatchLeftOutReason;
}

export interface BatchCandidates {
  /** Scope questions from the team that it recommends approving, in the list's order. */
  readonly candidates: readonly QuestionItem[];
  /** Questions, designs and release decisions that need the owner's own answer; action items are in neither list. */
  readonly leftOut: readonly BatchLeftOut[];
}

/**
 * What "Approve team recommendations" offers (#220): the same rule the server re-checks on every item before it
 * writes (`batchVerdictOf`), so the dialog never lists an item the batch route would refuse — and the route never
 * trusts this list.
 */
export function batchCandidatesOf(items: readonly QuestionItem[]): BatchCandidates {
  const candidates: QuestionItem[] = [];
  const leftOut: BatchLeftOut[] = [];
  for (const item of items) {
    const verdict = batchVerdictOf(item);
    if (verdict.kind === 'batch') {
      candidates.push(item);
    } else if (verdict.kind === 'left-out') {
      leftOut.push({ item, reason: verdict.reason });
    }
  }
  return { candidates, leftOut };
}
