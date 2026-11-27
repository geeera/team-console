/** Narrowing helpers the DTO guards share; internal to the contracts lib (only `DISPLAY_NAME_MAX` is re-exported). */

export const isString = (value: unknown): value is string => typeof value === 'string';

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** A count: a non-negative safe integer. */
export const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isNullable<T>(value: unknown, is: (inner: unknown) => inner is T): value is T | null {
  return value === null || is(value);
}

/** The longest display name a user row keeps (#775, migration 0038's CHECK). */
export const DISPLAY_NAME_MAX = 255;

/** A person's display name as the Worker sends it (#775): non-empty and bounded; plain text, never markup. */
export function isDisplayName(value: unknown): value is string {
  // Code points, not UTF-16 units: the writer and migration 0038's CHECK count code points.
  if (typeof value !== 'string' || value.length === 0) return false;
  return value.length <= DISPLAY_NAME_MAX || [...value].length <= DISPLAY_NAME_MAX;
}
