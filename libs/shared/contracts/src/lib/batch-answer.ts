import type { ProblemDetails } from './problem-details';

/**
 * Approving the team's recommendations in one go (#220, architect note on #29 §4). Only questions about scope that
 * the team recommends approving are batched; everything else is answered one by one.
 */

/** The owner decision a question is about: the plugin's `owner.CATEGORIES`, from its `owner:<category>` label. */
export type OwnerCategory = 'money' | 'scope' | 'release' | 'access' | 'legal' | 'design';

/** The first command of an answer line that says it recommends one (`recommendationOf` in the owner grammar). */
export type TeamRecommendation = 'approve' | 'reject' | 'go' | 'no-go';

/**
 * Why an item waiting for the owner is not in the batch. `uncategorised`: a question without an `owner:*` label
 * (the plugin always sets one; it is missing only when someone removed it).
 */
export type BatchLeftOutReason =
  | 'untrusted'
  | 'money'
  | 'release'
  | 'legal'
  | 'access'
  | 'design'
  | 'uncategorised'
  | 'reject'
  | 'no-recommendation';

/** Issues one batch may answer: 15 × (issue read + comment) + token + repository read stays within 44 subrequests. */
export const BATCH_ANSWER_MAX = 15;

/** `POST /api/v1/projects/:slug/answers/batch`. */
export interface BatchAnswerRequest {
  /** 1–15 distinct issue numbers, answered in this order. */
  readonly numbers: readonly number[];
  /** The owner's words, quoted in every comment (the same words for every item, so a repeat replays). */
  readonly ownerSaid: string;
}

export interface BatchAnswerWritten {
  readonly number: number;
  readonly ok: true;
  readonly commentId: number;
  readonly url: string;
  /** Answered from the 60 s replay window, not posted again. */
  readonly replayed: boolean;
}

export interface BatchAnswerFailed {
  readonly number: number;
  readonly ok: false;
  /** `batch-not-safe` carries `reason` (a `BatchLeftOutReason`); GitHub failures keep their usual types. */
  readonly problem: ProblemDetails;
}

export type BatchAnswerResult = BatchAnswerWritten | BatchAnswerFailed;

/** 200 for every batch that was attempted, whatever happened to its items; one result per number, in order. */
export interface BatchAnswerResponse {
  readonly results: readonly BatchAnswerResult[];
}
