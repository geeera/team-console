import { handledMarkerOf, type HandledResult } from '@shared/owner-grammar';
import { TRUSTED_BOT_LOGINS } from './untrusted-text';

/** A GitHub issue comment as the handled-marker rule needs it (REST or a webhook payload). */
export interface HandledCandidate {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string | null;
  readonly authorType: string | null;
  /** ISO 8601 as GitHub sends it. */
  readonly createdAt: string | null;
  /** `null` when the source has none (a webhook's `created` delivery is the first version by definition). */
  readonly updatedAt: string | null;
}

/** What a trusted handled marker says; the row it names is checked by `OwnerRequestsRepo.markHandled`. */
export interface HandledRequest {
  /** The request comment the marker names. */
  readonly commentId: number;
  readonly handledCommentId: number;
  readonly result: HandledResult;
  /** ISO 8601: the handled comment's `created_at`. */
  readonly handledAt: string;
}

/**
 * The PM's handled marker on an owner request (ADR 0005 decision 3), or `null`. Counts only when the comment's first
 * line is exactly the marker with strict JSON (`handledMarkerOf`), the author is the team's app (`type: Bot` and a
 * login in `TRUSTED_BOT_LOGINS` — never `isTrustedAuthor`: a collaborator must not be able to tell the owner the
 * PM acted), and, when `requireUnedited` (the form's re-read), the comment was never edited. The same project,
 * issue and "after the request" are the repository's to check.
 */
export function handledRequestOf(comment: HandledCandidate, requireUnedited: boolean): HandledRequest | null {
  const marker = handledMarkerOf(comment.body);
  if (marker === null) {
    return null;
  }
  if (
    comment.authorType !== 'Bot' ||
    comment.authorLogin === null ||
    !TRUSTED_BOT_LOGINS.has(comment.authorLogin)
  ) {
    return null;
  }
  if (comment.createdAt === null || !Number.isFinite(Date.parse(comment.createdAt))) {
    return null;
  }
  if (requireUnedited && comment.updatedAt !== comment.createdAt) {
    return null;
  }
  return {
    commentId: marker.commentId,
    handledCommentId: comment.id,
    result: marker.result,
    handledAt: comment.createdAt,
  };
}
