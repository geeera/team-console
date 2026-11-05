import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startCloseRelay, type CloseRelay } from './close-relay';

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A keep-alive target that records what reached it and answers 201 with a body and a custom header. */
async function startTarget(): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push({
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      outgoing.writeHead(201, {
        'Content-Type': 'application/json',
        'X-Fake': 'yes',
        'Keep-Alive': 'timeout=5',
      });
      outgoing.end('{"ok":true}');
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()));
  cleanups.push(
    () =>
      new Promise<void>((closed) => {
        server.close(() => closed());
        server.closeAllConnections();
      }),
  );
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function relayTo(target: string, errors: Error[] = []): Promise<CloseRelay> {
  const relay = await startCloseRelay(target, (error) => errors.push(error));
  cleanups.push(() => relay.close());
  return relay;
}

/** One request on a plain socket (no agent), so the test sees the relay's own connection headers. */
function send(origin: string, method: string, path: string, body?: string): Promise<Answer> {
  const url = new URL(path, origin);
  return new Promise<Answer>((answered, fail) => {
    const outgoing = request(
      url,
      { method, agent: false, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          answered({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', fail);
    outgoing.end(body);
  });
}

describe('startCloseRelay', () => {
  it('relays the method, path, query and body, and the status, headers and body back', async () => {
    const target = await startTarget();
    const relay = await relayTo(target.origin);

    const answer = await send(
      relay.origin,
      'POST',
      '/api.github.com/repos/o/r/issues/1/comments?x=1',
      '{"body":"/approve"}',
    );

    expect(answer.status).toBe(201);
    expect(answer.body).toBe('{"ok":true}');
    expect(answer.headers['x-fake']).toBe('yes');
    expect(target.seen).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/api.github.com/repos/o/r/issues/1/comments?x=1',
        body: '{"body":"/approve"}',
      }),
    ]);
    expect(target.seen[0]?.headers.host).toBe(new URL(target.origin).host);
  });

  it('closes every downstream connection after its answer, whatever the target says', async () => {
    const target = await startTarget();
    const relay = await relayTo(target.origin);

    const answer = await send(relay.origin, 'GET', '/_fake/state');

    expect(answer.headers.connection).toBe('close');
    expect(answer.headers['keep-alive']).toBeUndefined();
  });

  it('opens a fresh upstream connection per request', async () => {
    const target = await startTarget();
    const relay = await relayTo(target.origin);

    await send(relay.origin, 'GET', '/one');
    await send(relay.origin, 'GET', '/two');

    expect(target.seen.map((request) => request.headers.connection)).toEqual(['close', 'close']);
  });

  it('drops the downstream socket and reports the error when the target is gone', async () => {
    const target = await startTarget();
    const errors: Error[] = [];
    const relay = await relayTo(target.origin, errors);
    await cleanups.shift()?.();

    await expect(send(relay.origin, 'GET', '/_fake/state')).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(errors).toHaveLength(1);
  });
});
