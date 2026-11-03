import { readBodyCapped } from './body';

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function chunkedRequest(chunks: readonly Uint8Array[]): Request {
  // A stream body is sent without Content-Length, like a chunked upload.
  return new Request('http://hooks.test/', { method: 'POST', body: streamOf(chunks) });
}

describe('readBodyCapped', () => {
  it('returns the exact bytes up to the cap', async () => {
    const result = await readBodyCapped(chunkedRequest([new Uint8Array([1, 2]), new Uint8Array([3])]), 3);
    expect(result.ok).toBe(true);
    expect(result.ok && Array.from(new Uint8Array(result.bytes))).toEqual([1, 2, 3]);
  });

  it('stops at one byte over the cap without Content-Length', async () => {
    const request = chunkedRequest([new Uint8Array(2), new Uint8Array(2)]);
    expect(request.headers.get('content-length')).toBeNull();
    await expect(readBodyCapped(request, 3)).resolves.toEqual({ ok: false });
  });

  it('refuses a declared Content-Length over the cap before reading', async () => {
    const request = new Request('http://hooks.test/', {
      method: 'POST',
      body: 'abcd',
      headers: { 'content-length': '4' },
    });
    await expect(readBodyCapped(request, 3)).resolves.toEqual({ ok: false });
  });

  it('reads an empty body as zero bytes', async () => {
    const result = await readBodyCapped(new Request('http://hooks.test/', { method: 'POST' }), 3);
    expect(result).toEqual({ ok: true, bytes: expect.any(ArrayBuffer) });
    expect(result.ok && result.bytes.byteLength).toBe(0);
  });
});
