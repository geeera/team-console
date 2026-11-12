const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * An ISO 8601 UTC instant normalised to `toISOString` (`…T10:00:00.000Z`), so stored values compare as strings; `null`
 * for anything else, an offset or a bare date included (#445: a provider's timestamps and the tracker's `since`).
 */
export function instantOf(value: unknown): string | null {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
