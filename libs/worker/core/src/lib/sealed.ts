/**
 * Authenticated encryption for values a Worker keeps at rest or hands to a browser to keep for it (ADR 0003
 * decision 4): a 32-byte master key from a secret, never used directly; per-purpose AES-256-GCM subkeys from
 * HKDF-SHA256; a fresh 12-byte IV per seal; the caller's AAD binds a ciphertext to where it belongs, so a
 * value moved to another column, cookie or environment does not open.
 */

const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
// AES-GCM's 16-byte tag plus the IV: anything shorter was never produced by `sealText`.
const MIN_SEALED_BYTES = IV_BYTES + 16;
const SEALED_PATTERN = /^[0-9a-f]+$/;

/** The master key secret is missing or not exactly 32 bytes of base64: a misconfigured Worker, never a weak key. */
export class MasterKeyError extends Error {
  constructor() {
    super('The master key must be 32 random bytes, base64-encoded');
    this.name = 'MasterKeyError';
  }
}

/** A sealed value that does not open under this key and AAD: tampered, moved, or sealed under another key. */
export class UnsealError extends Error {
  constructor() {
    super('The sealed value could not be opened');
    this.name = 'UnsealError';
  }
}

export interface MasterKey {
  /** First 8 hex digits of SHA-256 of the key bytes: tells keys apart without revealing them. */
  readonly keyId: string;
  /** HKDF-SHA256 subkey for AES-256-GCM; `salt` separates environments, `info` separates purposes. */
  deriveKey(salt: string, info: string): Promise<CryptoKey>;
}

function bytesOfBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesOfHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !SEALED_PATTERN.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const encoder = new TextEncoder();

/** Imports the master key secret; throws `MasterKeyError` unless it is exactly 32 bytes of base64. */
export async function importMasterKey(base64: string | undefined): Promise<MasterKey> {
  const bytes = base64 === undefined ? null : bytesOfBase64(base64);
  if (bytes === null || bytes.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError();
  }
  const keyId = hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 8);
  const hkdf = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return {
    keyId,
    deriveKey: async (salt, info) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(salt), info: encoder.encode(info) },
        hkdf,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
  };
}

/**
 * Seals `plaintext` under `key` with `aad` bound in. Hex output: safe in a cookie and in SQL text, and it can
 * never contain a credential-shaped substring the sentinel tests look for.
 */
export async function sealText(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(plaintext),
    ),
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.length);
  sealed.set(iv);
  sealed.set(ciphertext, IV_BYTES);
  return hexOf(sealed);
}

/** Opens a value from `sealText`; any failure (format, tag, AAD, key) is one `UnsealError`, with no detail. */
export async function openText(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const bytes = bytesOfHex(sealed);
  if (bytes === null || bytes.length < MIN_SEALED_BYTES) {
    throw new UnsealError();
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(aad) },
      key,
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext);
  } catch {
    // The runtime's reason ("decryption failed") adds nothing and must not suggest which check failed.
    throw new UnsealError();
  }
}

/** Compares two strings without an early exit, for secrets such as an OAuth `state`. */
export function timingSafeEqualText(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** `bytes` random bytes as hex (for `state` values and PKCE verifiers: hex is within RFC 7636's alphabet). */
export function randomHex(bytes: number): string {
  return hexOf(crypto.getRandomValues(new Uint8Array(bytes)));
}
