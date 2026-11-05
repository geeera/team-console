import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
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

interface Target {
  readonly origin: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

type Respond = (incoming: IncomingMessage, outgoing: ServerResponse) => void;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const answerCreated: Respond = (_incoming, outgoing) => {
  outgoing.writeHead(201, { 'Content-Type': 'application/json', 'X-Fake': 'yes', 'Keep-Alive': 'timeout=5' });
  outgoing.end('{"ok":true}');
};

/** A keep-alive target that records what reached it, then answers with `respond`. */
async function startTarget(respond: Respond = answerCreated): Promise<Target> {
  const seen: Seen[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push({
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      respond(incoming, outgoing);
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()));
  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    await new Promise<void>((closed) => {
      server.close(() => closed());
      server.closeAllConnections();
    });
  };
  cleanups.push(close);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close };
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
        incoming.on('error', fail);
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

  it.each([404, 422, 500, 503])(
    'passes a %i answer through with its body, as no relay error',
    async (status) => {
      const target = await startTarget((_incoming, outgoing) => {
        outgoing.writeHead(status, { 'Content-Type': 'application/json' });
        outgoing.end(`{"status":${status}}`);
      });
      const errors: Error[] = [];
      const relay = await relayTo(target.origin, errors);

      const answer = await send(relay.origin, 'GET', '/api.github.com/repos/o/r/issues/9');

      expect(answer.status).toBe(status);
      expect(answer.body).toBe(`{"status":${status}}`);
      expect(errors).toEqual([]);
    },
  );

  it('relays a 204 without a body', async () => {
    const target = await startTarget((_incoming, outgoing) => {
      outgoing.writeHead(204, { 'X-Fake': 'empty' });
      outgoing.end();
    });
    const relay = await relayTo(target.origin);

    const answer = await send(relay.origin, 'DELETE', '/api.github.com/repos/o/r/issues/1/labels/x');

    expect(answer.status).toBe(204);
    expect(answer.body).toBe('');
    expect(answer.headers['x-fake']).toBe('empty');
    expect(answer.headers.connection).toBe('close');
  });

  it('relays a HEAD answer with its headers and no body', async () => {
    const target = await startTarget();
    const relay = await relayTo(target.origin);

    const answer = await send(relay.origin, 'HEAD', '/_fake/state');

    expect(answer.status).toBe(201);
    expect(answer.body).toBe('');
    expect(answer.headers['x-fake']).toBe('yes');
    expect(target.seen[0]?.method).toBe('HEAD');
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

    expect(target.seen.map((seen) => seen.headers.connection)).toEqual(['close', 'close']);
  });

  it('drops the downstream socket and reports the error when the target is gone', async () => {
    const target = await startTarget();
    const errors: Error[] = [];
    const relay = await relayTo(target.origin, errors);
    await target.close();

    await expect(send(relay.origin, 'GET', '/_fake/state')).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(errors).toHaveLength(1);
  });

  it('drops the downstream socket and reports the error when the body breaks off mid-way', async () => {
    const target = await startTarget((_incoming, outgoing) => {
      outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      outgoing.write('{"partial":');
      setTimeout(() => outgoing.socket?.destroy(), 20);
    });
    const errors: Error[] = [];
    const relay = await relayTo(target.origin, errors);

    await expect(send(relay.origin, 'GET', '/api.github.com/repos/o/r/issues/1')).rejects.toThrow(
      /aborted|socket hang up|ECONNRESET/,
    );
    await expect.poll(() => errors.length).toBe(1);
  });

  it('tears the upstream request down when the api side goes away first', async () => {
    let upstreamClosed = false;
    const target = await startTarget((incoming) => {
      // Never answers: only the api giving up can end this exchange.
      incoming.socket.on('close', () => {
        upstreamClosed = true;
      });
    });
    const errors: Error[] = [];
    const relay = await relayTo(target.origin, errors);

    const abandoned = request(new URL('/slow', relay.origin), { agent: false });
    // Destroying our own request rejects it with "socket hang up"; that is the point, not a failure.
    const abandonedErrors: Error[] = [];
    abandoned.on('error', (error) => abandonedErrors.push(error));
    abandoned.end();
    await expect.poll(() => target.seen.length).toBe(1);
    abandoned.destroy();

    await expect.poll(() => upstreamClosed).toBe(true);
    expect(errors).toEqual([]);
  });
});
