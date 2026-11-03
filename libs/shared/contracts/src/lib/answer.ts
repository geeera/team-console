import type { ProblemDetails } from './problem-details';

/**
 * The owner's inbox sections an answer can be given in (the plugin's `inbox.classify`): a question, a design
 * waiting for approval, the demo's release decision, an owner action item, a task that needs the owner's machine.
 */
export type Section = 'question' | 'design' | 'release' | 'owner' | 'local';

/** What the owner can answer with (the plugin's `brief.ANSWERABLE`); `done` is only for action items. */
export type AnswerCommand = 'approve' | 'reject' | 'go' | 'no-go' | 'override' | 'done';

/** Upper bound of `text` and `ownerSaid`, in UTF-16 code units. */
export const ANSWER_TEXT_MAX_LENGTH = 2000;

/** `POST /api/v1/projects/:slug/issues/:number/answer`. */
export interface AnswerRequest {
  readonly command: AnswerCommand;
  /** The reason or note after the command; required for `reject`, `no-go` and `override`. */
  readonly text?: string;
  /** The owner's own words, quoted in the comment so the answer can be traced to them. */
  readonly ownerSaid: string;
}

/** 201 for a new comment; 200 with `Idempotent-Replayed: true` and `replayed: true` for a repeat within 60 s. */
export interface AnswerResponse {
  readonly commentId: number;
  readonly url: string;
  readonly section: Section;
  readonly command: AnswerCommand;
  readonly replayed: boolean;
}

/**
 * A repeat of the same answer within this window is answered from the console's own writes instead of being posted
 * again (ADR 0001 decision 19). The console re-reads the item before repeating an answer it first sent longer ago (#120).
 */
export const ANSWER_REPLAY_WINDOW_MS = 60_000;

/** The furthest back `POST …/answer/lookup` looks for a comment the console already wrote (#120). */
export const ANSWER_LOOKUP_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * `POST /api/v1/projects/:slug/issues/:number/answer/lookup` (#120): the item re-read before an answer is repeated
 * past the replay window. The same fields as the `AnswerRequest` being repeated, plus how long ago (milliseconds,
 * measured on the device) it was first sent. Nothing is written.
 */
export interface AnswerLookupRequest extends AnswerRequest {
  readonly sentAgoMs: number;
}

/**
 * 200: the issue still takes this answer. `answer` is the comment the console already wrote with exactly this
 * answer since it was first sent (`replayed: true`), or `null` when none is on the issue and the answer may be
 * posted. An issue that no longer takes it answers the answer route's problems (`issue-closed`, `answer-*`).
 */
export interface AnswerLookupResponse {
  readonly answer: AnswerResponse | null;
}

/** Why the grammar refused an answer; the problem type is `answer-<code>`. */
export type AnswerRefusalCode = 'not-waiting' | 'not-allowed' | 'needs-words' | 'needs-reason';

/** 422 `answer-<code>`: the issue's section as the server derived it and the commands it accepts. */
export interface AnswerProblem extends ProblemDetails {
  readonly section: Section | null;
  readonly allowed: readonly AnswerCommand[];
}
