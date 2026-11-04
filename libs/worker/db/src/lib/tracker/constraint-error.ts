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
