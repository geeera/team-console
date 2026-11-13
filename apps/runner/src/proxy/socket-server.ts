import { chmod, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { problemTypeOf } from '@shared/contracts';
import { redactedJsonBody } from '../client/redact';
import type { ForwardRequest, ForwardResponse } from '../client/runner-client';
import { ensurePrivateDir, pathExists } from '../config/private-files';
import type { JobRegistry } from './job-registry';
import { pathClassOf, routeOf, type PathClass, type ProxyJob, type ProxyRefusal } from './router';

/**
 * A job's one way to the console (ADR 0006 R4, ADR 0008 decision 6): HTTP over a Unix socket at
 * `jobs/<id>/sock/tc.sock`, one socket per job, no TCP port ever. Node has no `getpeereid` without a native addon
 * (ruled out by decision 1), so the peer check is the socket's directory and mode (only the job's user reaches it;
 * the `user` backend makes it `_tcrunner:_tcjob 0750`, the socket 0660) plus the job token: every request's `Bearer tcj_…`
 * must be the token of the job this socket was opened for. Anything else is 401/403 with a `notice` on that job.
 * Requests and responses are never logged; a notice names the method, a path class and the status only.
 */

/** ADR 0008 decision 6. */
export const PROXY_BODY_MAX_BYTES = 256 * 1024;
/** `sun_path` holds 104 bytes on macOS (108 on Linux), the terminating NUL included. */
export const SOCKET_PATH_MAX_BYTES = 103;
const REQUEST_TIMEOUT_MS = 60_000;
const BEARER = /^Bearer[ ]+(\S+)$/;
/** Request headers a job may send on; the credentials are the runner's to add. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
] as const;

export type ProxyNoticeReason =
  ProxyRefusal | 'token-missing' | 'token-unknown' | 'token-foreign' | 'body-too-large' | 'body-not-json';

export interface ProxyNotice {
  readonly proxy: 'refused';
  readonly method: string;
  readonly pathClass: PathClass;
  readonly status: number;
  readonly reason: ProxyNoticeReason;
}

/** What the socket needs from the runner client: forwarding with the runner's credentials added. */
export interface ProxyForwarder {
  forwardForProject(jobToken: string, request: ForwardRequest): Promise<ForwardResponse>;
  forwardForRunnerJob(request: ForwardRequest): Promise<ForwardResponse>;
}

export interface JobSocketOptions {
  readonly socketPath: string;
  readonly job: ProxyJob;
  readonly registry: JobRegistry;
  readonly forwarder: ProxyForwarder;
  /** Posts a `notice` event on the job (the runner client's `events`). */
  readonly notice: (jobId: string, notice: ProxyNotice) => Promise<void>;
  /** A failure the socket cannot answer to the job (a notice that did not post, an upstream error). */
  readonly onError: (error: unknown) => void;
  /** The socket file's mode; 0600 (the runner's user only) unless a backend opens it to its job user. */
  readonly socketMode?: number | undefined;
  readonly maxBodyBytes?: number;
}

export interface JobSocket {
  readonly path: string;
  readonly server: Server;
  close(): Promise<void>;
}

class BodyTooLarge extends Error {}

function sendProblem(response: ServerResponse, status: number, slug: string, title: string): void {
  const body = JSON.stringify({ type: problemTypeOf(slug), title, status });
  response.writeHead(status, {
    'Content-Type': 'application/problem+json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) {
      throw new BodyTooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function forwardedHeadersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

/** A JSON body after the redactor, `null` for none, or `undefined` when it is not JSON (refused). */
function redactedBodyOf(raw: Buffer, contentType: string | undefined): string | null | undefined {
  if (raw.length === 0) {
    return null;
  }
  if (contentType === undefined || !/^application\/(?:[a-z.+-]+\+)?json\b/i.test(contentType)) {
    return undefined;
  }
  try {
    return redactedJsonBody(JSON.parse(raw.toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
}

export async function startJobSocket(options: JobSocketOptions): Promise<JobSocket> {
  const { socketPath, job, registry, forwarder } = options;
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `socket path is longer than ${String(SOCKET_PATH_MAX_BYTES)} bytes; choose a shorter TC_RUNNER_HOME`,
    );
  }
  await ensurePrivateDir(dirname(socketPath));
  if (await pathExists(socketPath)) {
    // A leftover could be another process's socket; the runner never reuses or deletes one it did not create.
    throw new Error(`${socketPath} already exists`);
  }
  const maxBodyBytes = options.maxBodyBytes ?? PROXY_BODY_MAX_BYTES;

  const refuse = async (
    response: ServerResponse,
    method: string,
    pathClass: PathClass,
    status: number,
    reason: ProxyNoticeReason,
  ): Promise<void> => {
    sendProblem(
      response,
      status,
      `proxy-${reason}`,
      status === 401 ? 'Unauthorized' : 'Refused by the runner',
    );
    try {
      await options.notice(job.id, { proxy: 'refused', method, pathClass, status, reason });
    } catch (error: unknown) {
      options.onError(error);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    const target = request.url ?? '';
    const bearer = BEARER.exec(request.headers.authorization?.trim() ?? '')?.[1];
    if (bearer === undefined) {
      return refuse(response, method, pathClassOf(target), 401, 'token-missing');
    }
    const owner = registry.jobOfToken(bearer);
    if (owner === null) {
      return refuse(response, method, pathClassOf(target), 401, 'token-unknown');
    }
    if (owner.id !== job.id) {
      return refuse(response, method, pathClassOf(target), 401, 'token-foreign');
    }

    const route = routeOf(method, target, job);
    if (route.kind === 'refused') {
      return refuse(response, method, route.pathClass, route.status, route.reason);
    }
    if (route.kind === 'not-yet') {
      // The key agent's ops arrive with 2-C (sign-verdict) and 3b (vcs-token).
      sendProblem(response, 501, 'not-yet', 'Not Implemented');
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(request, maxBodyBytes);
    } catch (error: unknown) {
      if (error instanceof BodyTooLarge) {
        response.setHeader('Connection', 'close');
        return refuse(response, method, route.kind, 413, 'body-too-large');
      }
      throw error;
    }
    const body = redactedBodyOf(raw, request.headers['content-type']);
    if (body === undefined) {
      return refuse(response, method, route.kind, 415, 'body-not-json');
    }
    const forwarded: ForwardRequest = {
      method,
      pathAndQuery: route.pathAndQuery,
      headers: forwardedHeadersOf(request),
      body,
    };
    let answer: ForwardResponse;
    try {
      answer =
        route.kind === 'project'
          ? await forwarder.forwardForProject(bearer, forwarded)
          : await forwarder.forwardForRunnerJob(forwarded);
    } catch (error: unknown) {
      options.onError(error);
      sendProblem(response, 502, 'console-unreachable', 'Bad Gateway');
      return;
    }
    response.writeHead(answer.status, { ...answer.headers, 'Content-Length': answer.body.length });
    response.end(answer.body);
  };

  const server = createServer({ requestTimeout: REQUEST_TIMEOUT_MS }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.onError(error);
      if (!response.headersSent) {
        sendProblem(response, 500, 'runner-proxy-failed', 'Internal Server Error');
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // A path, never a port: R4 (no TCP loopback listener a same-host process could reach).
    server.listen({ path: socketPath, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, options.socketMode ?? 0o600);

  return {
    path: socketPath,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
      await rm(socketPath, { force: true });
    },
  };
}
