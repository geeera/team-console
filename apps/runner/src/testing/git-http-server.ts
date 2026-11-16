import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A git smart-HTTP server on loopback for the `run-once --oidc` specs: `git http-backend` behind a node HTTP server,
 * serving the bare repositories under `root` to a request with the expected `Authorization` only (anything else is
 * 401), and recording every `Authorization` it saw. It stands in for GitHub's clone endpoint with
 * `${{ github.token }}`, so a spec proves the read token reaches git's request and nowhere else.
 */

export interface GitHttpServer {
  readonly origin: string;
  /** Every `Authorization` header received, in order; `null` for a request without one. */
  readonly authorizations: readonly (string | null)[];
  close(): Promise<void>;
}

export const basicAuthorizationOf = (token: string): string =>
  `basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

function serve(root: string, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      REQUEST_METHOD: request.method ?? 'GET',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      REMOTE_ADDR: '127.0.0.1',
      ...(request.headers['content-encoding'] === undefined
        ? {}
        : { HTTP_CONTENT_ENCODING: String(request.headers['content-encoding']) }),
      ...(request.headers['git-protocol'] === undefined
        ? {}
        : { GIT_PROTOCOL: String(request.headers['git-protocol']) }),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  request.pipe(child.stdin);
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.once('close', () => {
    const output = Buffer.concat(chunks);
    const split = output.indexOf('\r\n\r\n');
    if (split === -1) {
      response.writeHead(500).end();
      return;
    }
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of output.subarray(0, split).toString('latin1').split('\r\n')) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') {
        status = Number.parseInt(value, 10);
      } else if (name !== '') {
        headers[name] = value;
      }
    }
    response.writeHead(status, headers).end(output.subarray(split + 4));
  });
}

export async function startGitHttpServer(root: string, expectedAuthorization: string): Promise<GitHttpServer> {
  const authorizations: (string | null)[] = [];
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? null;
    authorizations.push(authorization);
    if (authorization !== expectedAuthorization) {
      request.resume();
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end();
      return;
    }
    serve(root, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    authorizations,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
