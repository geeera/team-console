/**
 * Whether a D1 failure is the SQLite constraint `marker` names (e.g. `UNIQUE constraint failed: labels.`). The
 * tracker repos let a constraint fail a whole batch on purpose, so a conflict writes nothing, not even its event.
 */
export function isConstraintError(error: unknown, marker: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return error.message.includes(marker) || cause.includes(marker);
}

/**
 * The one CHECK a lost race trips: 0014's `asks` CHECK that keeps an answer and a withdrawal apart (an ask withdrawn
 * by a new ask while the owner's decision was in flight). SQLite names an unnamed CHECK by its expression.
 */
const ASK_ANSWERED_OR_WITHDRAWN =
  'CHECK constraint failed: answered_by_decision_id IS NULL OR withdrawn_at IS NULL';

/**
 * Whether a failed batch lost a race on an append-only row (#434): a trigger refused a second answer, withdrawal,
 * reversal or open ask, or the asks CHECK refused answering a withdrawn ask. The caller re-reads and decides again.
 * Any other constraint is a bug and is rethrown, never retried into a 409 `item-changed` (#443).
 */
export function isAppendOnlyConflict(error: unknown): boolean {
  return isConstraintError(error, 'are append-only') || isConstraintError(error, ASK_ANSWERED_OR_WITHDRAWN);
}

/** Runs `statements` as one batch; `false` when it lost a race on an append-only row, so nothing was written. */
export async function batchUnlessConflict(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<boolean> {
  try {
    await db.batch([...statements]);
    return true;
  } catch (error: unknown) {
    if (isAppendOnlyConflict(error)) {
      return false;
    }
    throw error;
  }
}
