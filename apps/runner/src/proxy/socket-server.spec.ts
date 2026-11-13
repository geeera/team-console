import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForwardRequest, ForwardResponse } from '../client/runner-client';
import { JOB_ID, OTHER_JOB_ID } from '../testing/fake-console';
import { JobRegistry } from './job-registry';
import { PROXY_BODY_MAX_BYTES, startJobSocket, type JobSocket, type ProxyNotice } from './socket-server';

const job = { id: JOB_ID, projectSlug: 'team-console' };
const token = `tcj_${'a'.repeat(43)}`;
const otherToken = `tcj_${'b'.repeat(43)}`;

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

function send(
  socketPath: string,
  options: { method?: string; path: string; headers?: OutgoingHttpHeaders; body?: string | Buffer },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, path: options.path, method: options.method ?? 'GET', headers: options.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

const auth = (value: string): OutgoingHttpHeaders => ({ Authorization: `Bearer ${value}` });

describe('job socket (threat model C3 / ADR 0006 R4)', () => {
  let dir: string;
  let socket: JobSocket | null;
  let registry: JobRegistry;
  let notices: { jobId: string; notice: ProxyNotice }[];
  let errors: unknown[];
  let forwarded: { kind: 'project' | 'runner-job'; jobToken: string | null; request: ForwardRequest }[];
  let upstream: () => Promise<ForwardResponse>;

  const socketPath = (): string => join(dir, 'jobs', JOB_ID.slice(-6), 'sock', 'tc.sock');

  async function open(
    overrides: { maxBodyBytes?: number; notice?: () => Promise<void> } = {},
  ): Promise<JobSocket> {
    socket = await startJobSocket({
      socketPath: socketPath(),
      job,
      registry,
      forwarder: {
        forwardForProject: async (jobToken, request) => {
          forwarded.push({ kind: 'project', jobToken, request });
          return upstream();
        },
        forwardForRunnerJob: async (request) => {
          forwarded.push({ kind: 'runner-job', jobToken: null, request });
          return upstream();
        },
      },
      notice:
        overrides.notice ??
        (async (jobId, notice) => {
          notices.push({ jobId, notice });
        }),
      onError: (error) => errors.push(error),
      ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
    });
    return socket;
  }

  beforeEach(async () => {
    // os.tmpdir(), not the workspace: a socket path must stay under 104 bytes.
    dir = await mkdtemp(join(tmpdir(), 'tcr-'));
    await mkdir(join(dir, 'jobs', JOB_ID.slice(-6)), { recursive: true, mode: 0o700 });
    socket = null;
    registry = new JobRegistry();
    registry.register(job, token);
    registry.register({ id: OTHER_JOB_ID, projectSlug: 'other-product' }, otherToken);
    notices = [];
    errors = [];
    forwarded = [];
    upstream = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"v7"' },
      body: Buffer.from('{"ok":true}'),
    });
  });

  afterEach(async () => {
    await socket?.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('where it listens', () => {
    it('listens on the socket path only, never a TCP port', async () => {
      const listen = vi.spyOn(Server.prototype, 'listen');
      const opened = await open();

      expect(opened.server.address()).toBe(socketPath());
      for (const call of listen.mock.calls) {
        const [first] = call as unknown[];
        expect(first).toEqual(expect.objectContaining({ path: socketPath() }));
        expect(first).not.toHaveProperty('port');
      }
      expect(listen).toHaveBeenCalled();
      listen.mockRestore();
    });

    it('creates the socket 0600 in a 0700 directory of the runner’s user', async () => {
      await open();
      expect((await stat(socketPath())).isSocket()).toBe(true);
      expect((await stat(socketPath())).mode & 0o777).toBe(0o600);
      expect((await stat(join(socketPath(), '..'))).mode & 0o777).toBe(0o700);
    });

    it('removes the socket file on close', async () => {
      const opened = await open();
      await opened.close();
      socket = null;
      await expect(stat(socketPath())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a path that already exists (never reuses or deletes another socket)', async () => {
      await mkdir(join(socketPath(), '..'), { mode: 0o700 });
      await writeFile(socketPath(), '');
      await expect(open()).rejects.toThrow(/already exists/);
    });

    it('refuses a socket directory others can write', async () => {
      await mkdir(join(socketPath(), '..'), { mode: 0o700 });
      await chmod(join(socketPath(), '..'), 0o777);
      await expect(open()).rejects.toMatchObject({ problem: 'home-unsafe' });
    });

    it('refuses a socket path longer than sun_path holds', async () => {
      await expect(
        startJobSocket({
          socketPath: join(dir, 'x'.repeat(120), 'tc.sock'),
          job,
          registry,
          forwarder: { forwardForProject: upstream, forwardForRunnerJob: upstream },
          notice: async () => undefined,
          onError: () => undefined,
        }),
      ).rejects.toThrow(/longer than 103 bytes/);
    });
  });

  describe('who may use it: the job token of this socket’s job, nothing else', () => {
    it.each([
      ['no Authorization header', {}, 'token-missing'],
      ['a non-Bearer scheme', { Authorization: `Basic ${token}` }, 'token-missing'],
      ['a token this runner never launched', auth(`tcj_${'z'.repeat(43)}`), 'token-unknown'],
      ['the runner JWT shape instead of a job token', auth('eyJhbGciOiJFZERTQSJ9.e30.sig'), 'token-unknown'],
      ['another job’s token (a foreign token)', auth(otherToken), 'token-foreign'],
    ])('401 for %s, with a notice on this job', async (_label, headers, reason) => {
      await open();
      const answer = await send(socketPath(), { path: '/api/v1/projects/team-console/items', headers });

      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body)).toMatchObject({
        type: `https://team-console/problems/proxy-${reason}`,
        status: 401,
      });
      expect(notices).toEqual([
        {
          jobId: JOB_ID,
          notice: { proxy: 'refused', method: 'GET', pathClass: 'project', status: 401, reason },
        },
      ]);
      expect(forwarded).toEqual([]);
    });

    it('401 once the job was dropped from the registry (its finish)', async () => {
      await open();
      registry.drop(JOB_ID);
      const answer = await send(socketPath(), {
        path: '/api/v1/projects/team-console/items',
        headers: auth(token),
      });
      expect(answer.status).toBe(401);
      expect(notices[0]?.notice.reason).toBe('token-unknown');
    });
  });

  describe('where a job may go', () => {
    it.each([
      ['GET', '/api/v1/projects/other-product/items', 403, 'other-project', 'project'],
      ['POST', `/api/v1/runner/jobs/${OTHER_JOB_ID}/events`, 403, 'other-job', 'runner-job'],
      ['POST', `/api/v1/runner/jobs/${JOB_ID}/finish`, 403, 'runner-route', 'runner-job'],
      ['GET', '/api/v1/accounts/x/runners', 403, 'path-not-allowed', 'other'],
      ['GET', '/api/v1/projects/team-console/%2e%2e/other-product', 403, 'path-malformed', 'other'],
    ])('%s %s → %i %s with a notice', async (method, path, status, reason, pathClass) => {
      await open();
      const answer = await send(socketPath(), { method, path, headers: auth(token) });

      expect(answer.status).toBe(status);
      expect(notices).toEqual([
        { jobId: JOB_ID, notice: { proxy: 'refused', method, pathClass, status, reason } },
      ]);
      expect(forwarded).toEqual([]);
    });

    it.each(['/ops/sign-verdict', '/ops/vcs-token'])(
      '%s answers 501 not-yet until 2-C / 3b',
      async (path) => {
        await open();
        const answer = await send(socketPath(), { method: 'POST', path, headers: auth(token), body: '{}' });

        expect(answer.status).toBe(501);
        expect(JSON.parse(answer.body)).toMatchObject({ type: 'https://team-console/problems/not-yet' });
        expect(forwarded).toEqual([]);
      },
    );

    it('a key-agent op without a valid token is 401 first', async () => {
      await open();
      const answer = await send(socketPath(), {
        method: 'POST',
        path: '/ops/sign-verdict',
        headers: auth(otherToken),
      });
      expect(answer.status).toBe(401);
    });

    it('forwards its own project’s call with only the allowed headers, and passes the answer back', async () => {
      await open();
      const answer = await send(socketPath(), {
        method: 'POST',
        path: '/api/v1/projects/team-console/items/7/comments?x=1',
        headers: {
          ...auth(token),
          'Content-Type': 'application/json',
          'Idempotency-Key': 'k-1',
          'X-Runner-Jwt': 'forged',
          Cookie: 'tc_session=1',
          'CF-Access-Client-Id': 'forged',
        },
        body: '{"body":"hello"}',
      });

      expect(answer.status).toBe(200);
      expect(answer.body).toBe('{"ok":true}');
      expect(answer.headers['etag']).toBe('"v7"');
      expect(forwarded).toEqual([
        {
          kind: 'project',
          jobToken: token,
          request: {
            method: 'POST',
            pathAndQuery: '/api/v1/projects/team-console/items/7/comments?x=1',
            headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
            body: '{"body":"hello"}',
          },
        },
      ]);
      expect(notices).toEqual([]);
    });

    it('forwards its own run-log events with the runner’s credentials (no job token)', async () => {
      await open();
      const answer = await send(socketPath(), {
        method: 'POST',
        path: `/api/v1/runner/jobs/${JOB_ID}/events`,
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: '{"events":[]}',
      });

      expect(answer.status).toBe(200);
      expect(forwarded[0]).toMatchObject({ kind: 'runner-job', jobToken: null });
    });

    it('forwards a GET without a body', async () => {
      await open();
      await send(socketPath(), { path: '/api/v1/projects/team-console/items', headers: auth(token) });
      expect(forwarded[0]?.request.body).toBeNull();
    });
  });

  describe('bodies', () => {
    it('413 past the body cap (256 KB by default), with a notice', async () => {
      expect(PROXY_BODY_MAX_BYTES).toBe(256 * 1024);
      await open({ maxBodyBytes: 1024 });
      const answer = await send(socketPath(), {
        method: 'POST',
        path: '/api/v1/projects/team-console/items',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'x'.repeat(2048) }),
      });

      expect(answer.status).toBe(413);
      expect(notices[0]?.notice).toMatchObject({ status: 413, reason: 'body-too-large' });
      expect(forwarded).toEqual([]);
    });

    it('413 for a chunked body that grows past the cap without a Content-Length', async () => {
      await open({ maxBodyBytes: 1024 });
      const answer = await send(socketPath(), {
        method: 'POST',
        path: '/api/v1/projects/team-console/items',
        headers: { ...auth(token), 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        body: Buffer.alloc(4096, 0x61),
      });
      expect(answer.status).toBe(413);
    });

    it.each([
      ['a body that is not JSON', 'application/json', 'not json'],
      ['a body without a JSON content type', 'text/plain', '{"a":1}'],
    ])('415 for %s, with a notice', async (_label, contentType, body) => {
      await open();
      const answer = await send(socketPath(), {
        method: 'POST',
        path: '/api/v1/projects/team-console/items',
        headers: { ...auth(token), 'Content-Type': contentType },
        body,
      });

      expect(answer.status).toBe(415);
      expect(notices[0]?.notice).toMatchObject({ status: 415, reason: 'body-not-json' });
      expect(forwarded).toEqual([]);
    });
  });

  describe('failures', () => {
    it('502 when the console cannot be reached; the error goes to the runner, not to the job', async () => {
      upstream = async () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED console.example');
      };
      await open();
      const answer = await send(socketPath(), {
        path: '/api/v1/projects/team-console/items',
        headers: auth(token),
      });

      expect(answer.status).toBe(502);
      expect(answer.body).not.toContain('ECONNREFUSED');
      expect(errors).toHaveLength(1);
    });

    it('still answers the job when its notice cannot be posted', async () => {
      await open({
        notice: async () => {
          throw new Error('events: the console answered 409');
        },
      });
      const answer = await send(socketPath(), {
        path: '/api/v1/projects/other-product',
        headers: auth(token),
      });

      expect(answer.status).toBe(403);
      expect(errors).toHaveLength(1);
    });
  });
});
