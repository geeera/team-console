/** Crockford base32 (no I, L, O, U), the alphabet of every ULID the console stores (`isUlid` in @shared/contracts). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

/**
 * A ULID: 48 bits of milliseconds since the epoch, then 80 random bits from the platform's CSPRNG. Sortable by time,
 * unguessable in its tail; the id shape of accounts, users, runners and jobs (ADR 0008 "Data model").
 */
export function newUlid(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  const timePart: string[] = [];
  for (let index = 0; index < TIME_CHARS; index += 1) {
    timePart.unshift(ALPHABET[time % 32] ?? '0');
    time = Math.floor(time / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  // 80 bits read five at a time: 16 characters, no leftover.
  let randomPart = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      randomPart += ALPHABET[(buffer >>> (bits - 5)) & 31] ?? '0';
      bits -= 5;
      buffer &= (1 << bits) - 1;
    }
  }
  return timePart.join('') + randomPart;
}
