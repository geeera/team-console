import { decodeBase64Url, encodeBase64Url } from '../lib/base64url';

/**
 * Test and local-run only: the user agent's side of RFC 8291 (decrypt) and of RFC 8292 (read the VAPID JWT), written
 * from the RFCs independently of the sending library, so a round trip proves the library against the standard.
 */

export interface ReceiverKeys {
  readonly privateKey: CryptoKey;
  /** 65-byte uncompressed point. */
  readonly publicKey: Uint8Array;
  readonly authSecret: Uint8Array;
}

/** A fresh browser-like key pair and auth secret, as `PushManager.subscribe` makes. */
export async function generateReceiverKeys(): Promise<ReceiverKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKey, authSecret: crypto.getRandomValues(new Uint8Array(16)) };
}

/** Imports a receiver from the RFC 8291 Appendix A style base64url values. */
export async function importReceiverKeys(publicKey: string, privateKey: string, authSecret: string): Promise<ReceiverKeys> {
  const point = bytesOf(publicKey);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(point.slice(1, 33)),
    y: encodeBase64Url(point.slice(33, 65)),
    d: privateKey,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  return { privateKey: key, publicKey: point, authSecret: bytesOf(authSecret) };
}

export function bytesOf(base64url: string): Uint8Array {
  const bytes = decodeBase64Url(base64url);
  if (bytes === null) {
    throw new Error('not base64url');
  }
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

/** HKDF (RFC 5869) for outputs of at most 32 bytes: one expand block is all RFC 8291 needs. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export class PushDecryptError extends Error {
  constructor(reason: string) {
    super(`push payload could not be decrypted: ${reason}`);
    this.name = 'PushDecryptError';
  }
}

/** Decrypts an `aes128gcm` push message body (RFC 8188 header, one record) for the receiver. */
export async function decryptPushPayload(body: Uint8Array, receiver: ReceiverKeys): Promise<Uint8Array> {
  if (body.length < 21) {
    throw new PushDecryptError('header too short');
  }
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const keyIdLength = body[20] ?? 0;
  if (keyIdLength !== 65 || body.length < 21 + keyIdLength + 17) {
    throw new PushDecryptError('bad key id');
  }
  const senderPublic = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);
  if (ciphertext.length > recordSize) {
    throw new PushDecryptError('more than one record');
  }
  const senderKey = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // workers-types spells the WebCrypto member `public` as `$public`; workerd itself takes the standard name.
  const ecdh = { name: 'ECDH', public: senderKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, receiver.privateKey, 256));
  const keyInfo = concat(text('WebPush: info\0'), receiver.publicKey, senderPublic);
  const ikm = await hkdf(receiver.authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  let padded: Uint8Array;
  try {
    padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
  } catch {
    throw new PushDecryptError('authentication failed');
  }
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) {
    end -= 1;
  }
  if (end < 0 || padded[end] !== 0x02) {
    throw new PushDecryptError('no last-record delimiter');
  }
  return padded.slice(0, end);
}

export interface VapidToken {
  readonly header: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
  /** The `k=` parameter: the sender's public key. */
  readonly publicKey: string;
  /** Whether the ES256 signature verifies with `publicKey`. */
  readonly signatureValid: boolean;
}

const VAPID_AUTH = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/;

function jsonPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytesOf(part)));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JWT part is not an object');
  }
  return parsed as Record<string, unknown>;
}

/** Reads `Authorization: vapid t=…, k=…` (RFC 8292 §3); `null` when the header has another shape. */
export async function readVapidAuthorization(header: string | null): Promise<VapidToken | null> {
  const match = VAPID_AUTH.exec(header ?? '');
  const token = match?.[1];
  const publicKey = match?.[2];
  if (token === undefined || publicKey === undefined) {
    return null;
  }
  const [head = '', payload = '', signature = ''] = token.split('.');
  const point = bytesOf(publicKey);
  const verifyKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(point.slice(1, 33)),
      y: encodeBase64Url(point.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signatureValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    bytesOf(signature),
    text(`${head}.${payload}`),
  );
  return { header: jsonPart(head), claims: jsonPart(payload), publicKey, signatureValid };
}
