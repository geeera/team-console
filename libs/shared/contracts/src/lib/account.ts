/**
 * Accounts are the tenant (ADR 0008 decisions 1, 3, 5 and 6; migration 0018). No route serves them yet (T-2 does).
 */

/** Crockford base32, 26 characters: the shape of every `accounts.id` and `users.id`. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID.test(value);
}

/**
 * The owner's account and user rows, created by migration 0018 with these fixed ids (a migration cannot generate a
 * ULID). `accounts.slug = 'owner'` is reserved, so no one else can create it.
 */
export const OWNER_ACCOUNT_ID = '01M6YSNJ000000000000000001';
export const OWNER_ACCOUNT_SLUG = 'owner';
export const OWNER_USER_ID = '01M6YSNJ000000000000000002';
