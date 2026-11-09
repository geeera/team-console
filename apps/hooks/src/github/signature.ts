/** The secrets a delivery may be signed with: the current one, then the previous one during a rotation. */
export function webhookSecretsOf(current: string | undefined, previous: string | undefined): string[] | null {
  if (current === undefined || current === '') {
    return null;
  }
  return previous === undefined || previous === '' ? [current] : [current, previous];
}

/** Lower-case hex SHA-256 of the raw body: the replay key that, unlike the delivery id, the signature covers. */
export async function sha256Hex(rawBody: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawBody));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
