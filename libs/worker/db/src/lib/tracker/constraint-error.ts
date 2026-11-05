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
 * Whether a failed batch lost a race on an append-only row (#434): a trigger refused a second answer, withdrawal,
 * reversal or open ask, or a CHECK refused answering a withdrawn ask. The caller re-reads and decides again.
 */
export function isAppendOnlyConflict(error: unknown): boolean {
  return isConstraintError(error, 'are append-only') || isConstraintError(error, 'CHECK constraint failed');
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
