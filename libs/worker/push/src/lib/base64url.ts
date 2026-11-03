const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Strict base64url (RFC 4648 §5; trailing padding tolerated), or `null` for anything else. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!BASE64URL.test(value)) {
    return null;
  }
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) {
    return null;
  }
  const base64 = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    // atob refuses non-canonical input; that is the same answer as a bad alphabet.
    return null;
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
