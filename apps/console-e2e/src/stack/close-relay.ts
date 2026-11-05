import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A loopback HTTP relay that serves every request on a connection of its own: `Connection: close` on each answer
 * downstream, a fresh socket (no agent) upstream.
 *
 * Why (#400): the api Worker reaches the fake GitHub and the fake push service over HTTP/1.1, workerd to workerd. The
 * server end closes a keep-alive connection after 5 s idle without a `Keep-Alive: timeout` hint, and the client end
 * pools idle connections for 5 s, so a request sent ~5 s after the previous one can go out on a socket the server is
 * closing at that very moment. workerd then throws "Network connection lost", the api answers 502
 * `github-unavailable`, and no request ever reaches the fake. Workers cannot opt out of the pool (`Connection` is
 * dropped from requests and responses alike), so the harness puts this relay between the two.
 */
export interface CloseRelay {
  /** `http://127.0.0.1:<port>` — what the api is pointed at instead of the target. */
  readonly origin: string;
  close(): Promise<void>;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) belong to one connection and are never relayed.
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
      kept[name] = value;
    }
  }
  return kept;
}

/**
 * Relays to `target` (a loopback origin) on a port the system picks. `onError` hears an upstream that failed; the
 * downstream socket is then dropped, so the api sees the network failure it would have seen going direct.
 */
export async function startCloseRelay(target: string, onError: (error: Error) => void): Promise<CloseRelay> {
  const upstreamOrigin = new URL(target);
  const server = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        protocol: upstreamOrigin.protocol,
        hostname: upstreamOrigin.hostname,
        port: upstreamOrigin.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...endToEndHeaders(incoming.headers), host: upstreamOrigin.host },
        // No pooling upstream either: the relay's own keep-alive socket to workerd would race the same 5 s close.
        agent: false,
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.statusMessage, {
          ...endToEndHeaders(answer.headers),
          connection: 'close',
        });
        answer.pipe(outgoing);
      },
    );
    upstream.on('error', (error) => {
      onError(error);
      outgoing.destroy();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((listening, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      listening();
    });
  });
  const address: string | AddressInfo | null = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error(`the relay to ${target} has no TCP port`);
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((closed, fail) => {
        server.close((error) => (error === undefined ? closed() : fail(error)));
        server.closeAllConnections();
      }),
  };
}
