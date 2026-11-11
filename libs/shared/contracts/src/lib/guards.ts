/** Narrowing helpers the DTO guards share; internal to the contracts lib (not part of its public API). */

export const isString = (value: unknown): value is string => typeof value === 'string';

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function isNullable<T>(value: unknown, is: (inner: unknown) => inner is T): value is T | null {
  return value === null || is(value);
}
