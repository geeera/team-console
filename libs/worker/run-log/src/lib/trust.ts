import type { RunLogComment } from './run-state';

export interface TeamComments {
  /** The team's own comments that REST proves unedited: these drive the run state. */
  readonly trusted: RunLogComment[];
  /** The team's comments that were edited: they only flag a run as `unknown` (see `parseRuns`). */
  readonly untrusted: RunLogComment[];
}

/**
 * `provenance.partition` in the plugin's REST-only mode — the only mode a Worker has (no GraphQL edit history):
 * comments by anyone outside `authors` are dropped, and a team comment counts only when `updated_at` is exactly
 * `created_at`. No slack: any tolerance would let an edit made within it count.
 */
export function partitionTeamComments(
  comments: readonly RunLogComment[],
  authors: Iterable<string>,
): TeamComments {
  const team = new Set([...authors].filter((login) => login !== '').map((login) => login.toLowerCase()));
  const trusted: RunLogComment[] = [];
  const untrusted: RunLogComment[] = [];
  for (const comment of comments) {
    if (!team.has(comment.author.toLowerCase())) {
      continue;
    }
    const isUnedited =
      comment.createdAt !== null && comment.createdAt !== '' && comment.createdAt === comment.updatedAt;
    (isUnedited ? trusted : untrusted).push(comment);
  }
  return { trusted, untrusted };
}
