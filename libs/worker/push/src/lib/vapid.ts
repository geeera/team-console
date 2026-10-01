import { decodeBase64Url } from './base64url';

/** The application server's VAPID identity (RFC 8292). The private key never leaves the Worker. */
export interface VapidConfig {
  /** base64url, 65-byte uncompressed P-256 point. */
  readonly publicKey: string;
  /** base64url, the 32-byte private scalar (`tools/owner-setup/vapid-keygen.js`). */
  readonly privateKey: string;
  /** An `https:` URL; never `mailto:` with the owner's address in this public repository (threat model, row 4). */
  readonly subject: string;
}

export interface VapidInput {
  readonly publicKey?: string | undefined;
  readonly privateKey?: string | undefined;
  readonly subject?: string | undefined;
}

export type VapidCheck =
  | { readonly ok: true; readonly config: VapidConfig }
  /** The names of the unusable settings, never their values. */
  | { readonly ok: false; readonly invalid: readonly ('publicKey' | 'privateKey' | 'subject')[] };

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates the shape of the configured key pair and subject; an unusable one fails closed. */
export function checkVapidConfig(input: VapidInput): VapidCheck {
  const publicKey = input.publicKey?.trim() ?? '';
  const privateKey = input.privateKey?.trim() ?? '';
  const subject = input.subject?.trim() ?? '';
  const publicBytes = decodeBase64Url(publicKey);
  const privateBytes = decodeBase64Url(privateKey);
  const invalid: ('publicKey' | 'privateKey' | 'subject')[] = [];
  if (publicBytes === null || publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    invalid.push('publicKey');
  }
  if (privateBytes === null || privateBytes.length !== 32) {
    invalid.push('privateKey');
  }
  if (!isHttpsUrl(subject)) {
    invalid.push('subject');
  }
  return invalid.length === 0 ? { ok: true, config: { publicKey, privateKey, subject } } : { ok: false, invalid };
}
