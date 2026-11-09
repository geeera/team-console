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

/**
 * Verifies `X-Hub-Signature-256` over the exact bytes received (moved here from the hooks Worker, #12). `crypto.subtle
 * .verify` compares in constant time and, unlike `timingSafeEqual`, cannot throw on a length mismatch: the strict
 * header format already fixes the length, so a malformed header is a plain `false` (401), never a 500.
 */
export async function verifyGitHubSignature(
  rawBody: ArrayBuffer,
  header: string | null | undefined,
  secrets: readonly string[],
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
