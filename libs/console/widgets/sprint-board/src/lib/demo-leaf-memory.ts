/**
 * What the board last showed in its demo leaf on this device (#363): the demo's day, the whole days left and the
 * leaf's words. The next visit compares against it to decide whether a day has turned since.
 */
export interface DemoLeafSeen {
  readonly due: string;
  readonly days: number;
  readonly line: string;
}

export const DEMO_LEAF_KEY = 'tc.demo-leaf.v1';

/**
 * The old leaf to tear away, or `null`: only when the same demo was last seen on another day, and only once a session,
 * so reopening the board never replays it.
 */
export function tornLeafOf(
  seen: DemoLeafSeen | null,
  now: DemoLeafSeen,
  isFirstTearOfSession: boolean,
): string | null {
  if (seen === null || !isFirstTearOfSession) {
    return null;
  }
  return seen.due === now.due && seen.days !== now.days && seen.line !== now.line ? seen.line : null;
}

/** A stored value that is not exactly a `DemoLeafSeen` is treated as never seen. */
export function isDemoLeafSeen(value: unknown): value is DemoLeafSeen {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { due, days, line } = value as Record<string, unknown>;
  return (
    typeof due === 'string' && typeof days === 'number' && Number.isFinite(days) && typeof line === 'string'
  );
}
