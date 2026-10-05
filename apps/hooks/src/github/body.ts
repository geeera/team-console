/** GitHub caps webhook payloads at 25 MB but ours are far smaller; 1 MB bounds the HMAC work per request. */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

export type BodyRead = { readonly ok: true; readonly bytes: ArrayBuffer } | { readonly ok: false };

/**
 * Reads the request body, giving up as soon as more than `maxBytes` arrived. `Content-Length` is only a fast
 * path: a chunked body has none and a client may lie, so the bytes actually read are what is counted (row 7).
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false };
  }
  if (request.body === null) {
    return { ok: true, bytes: new ArrayBuffer(0) };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // Released, not cancelled: the runtime discards the rest, while a cancelled request stream breaks
      // wrangler dev's body-draining middleware (the local proxy drops the connection).
      reader.releaseLock();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: bytes.buffer };
}
