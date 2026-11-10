const RANDOM_BYTES = 32;

/**
 * An opaque bearer secret: `prefix` and 256 random bits as 43 base64url characters — the shape of a job token
 * (`tcj_`) and an enrolment code (`tce_`), which `@shared/redaction` recognises by the prefix. The value is shown
 * once; D1 holds its SHA-256 (`sha256Hex`).
 */
export function randomOpaqueToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const base64url = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${prefix}${base64url}`;
}
