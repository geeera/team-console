// GitHub sends lower-case hex only; anything else (sha1=, upper case, short, padded) is refused, never "fixed".
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/;

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** The secrets a delivery may be signed with: the current one, then the previous one during a rotation. */
export function webhookSecretsOf(current: string | undefined, previous: string | undefined): string[] | null {
  if (current === undefined || current === '') {
    return null;
  }
  return previous === undefined || previous === '' ? [current] : [current, previous];
}

/**
 * Verifies `X-Hub-Signature-256` over the exact bytes received. `crypto.subtle.verify` compares in constant
 * time and, unlike `timingSafeEqual`, cannot throw on a length mismatch: the strict header format already fixes
 * the length, so a malformed header is a plain `false` (401), never a 500 (threat model on #12, row 2).
 */
export async function verifySignature(
  secrets: readonly string[],
  rawBody: ArrayBuffer,
  header: string | null | undefined,
): Promise<boolean> {
  const match = header === null || header === undefined ? null : SIGNATURE_HEADER.exec(header);
  const hex = match?.[1];
  if (hex === undefined) {
    return false;
  }
  const signature = hexToBytes(hex);
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    if (await crypto.subtle.verify('HMAC', key, signature, rawBody)) {
      return true;
    }
  }
  return false;
}

/** Lower-case hex SHA-256 of the raw body: the replay key that, unlike the delivery id, the signature covers. */
export async function sha256Hex(rawBody: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawBody));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
