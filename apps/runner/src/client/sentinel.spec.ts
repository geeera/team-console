import { generateKeyPairSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRegistry } from '../proxy/job-registry';
import { startJobSocket, type JobSocket } from '../proxy/socket-server';
import { JOB_ID, RUNNER_ID, fakeConsole, json, sentinels } from '../testing/fake-console';
import { redactJson } from './redact';
import { RunnerClient } from './runner-client';

/**
 * Threat model C2 "events leak a token": a job token, an enrolment code, an Anthropic key and a GitHub installation
 * token planted in whatever the runner sends — events, a finish summary and metrics, a heartbeat, a job's own
 * request through the proxy — never reach the console's side of the wire.
 */

const planted = Object.values(sentinels);
const prose = (secret: string): string => `the CLI printed ${secret} while it worked`;

function assertNoSentinel(bodies: readonly (string | null)[]): void {
  const wire = bodies.join('\n');
  for (const secret of planted) {
    expect(wire).not.toContain(secret);
  }
  expect(wire).toContain('[redacted:');
}

function client() {
  const fake = fakeConsole((request) =>
    request.url.endsWith('/events')
      ? json(201, { lastSeq: 1, capped: false })
      : json(200, { leaseUntil: 'x' }),
  );
  const runner = new RunnerClient({
    apiUrl: 'https://console.example',
    runnerId: RUNNER_ID,
    audience: 'team-console:dev',
    privateKey: generateKeyPairSync('ed25519').privateKey,
    fetch: fake.fetch,
  });
  return { runner, requests: fake.requests };
}

describe('sentinel: no planted secret leaves the runner in a body', () => {
  it('redacts every string, key and nested value of an event payload', async () => {
    const { runner, requests } = client();

    await runner.events(JOB_ID, [
      { level: 'info', kind: 'log', payload: { line: prose(sentinels.jobToken) } },
      {
        level: 'warn',
        kind: 'notice',
        payload: { nested: { list: [prose(sentinels.anthropicKey), { deep: sentinels.githubToken }] } },
      },
      { level: 'error', kind: 'log', payload: { [sentinels.enrolmentCode]: 'a secret as a key' } },
    ]);

    assertNoSentinel(requests.map((request) => request.body));
  });

  it('redacts the finish summary and its metrics', async () => {
    const { runner, requests } = client();

    await runner.finish(JOB_ID, {
      result: 'failed',
      summary: planted.map(prose).join('; '),
      metrics: { stderr: [sentinels.anthropicKey, sentinels.githubToken] },
      acted: false,
    });

    assertNoSentinel(requests.map((request) => request.body));
  });

  it('leaves non-string values and ordinary text as they are', () => {
    expect(redactJson({ a: 1, b: true, c: null, d: ['plain text', 2] })).toEqual({
      a: 1,
      b: true,
      c: null,
      d: ['plain text', 2],
    });
  });

  describe('a job’s request through the socket', () => {
    let dir: string;
    let socket: JobSocket | null = null;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'tcr-'));
    });

    afterEach(async () => {
      await socket?.close();
      socket = null;
      await rm(dir, { recursive: true, force: true });
    });

    it('is redacted before it is forwarded, to the project and to the run log alike', async () => {
      const fake = fakeConsole(() => json(201, {}));
      const runner = new RunnerClient({
        apiUrl: 'https://console.example',
        runnerId: RUNNER_ID,
        audience: 'team-console:dev',
        privateKey: generateKeyPairSync('ed25519').privateKey,
        fetch: fake.fetch,
      });
      const registry = new JobRegistry();
      const jobToken = `tcj_${'k'.repeat(43)}`;
      registry.register({ id: JOB_ID, projectSlug: 'team-console' }, jobToken);
      socket = await startJobSocket({
        socketPath: join(dir, 'sock', 'tc.sock'),
        job: { id: JOB_ID, projectSlug: 'team-console' },
        registry,
        forwarder: runner,
        notice: async () => undefined,
        onError: (error) => {
          throw error;
        },
      });

      for (const path of [
        '/api/v1/projects/team-console/items/7/comments',
        `/api/v1/runner/jobs/${JOB_ID}/events`,
      ]) {
        const body = JSON.stringify({
          body: planted.map(prose).join('\n'),
          events: [{ payload: { k: sentinels.githubToken } }],
        });
        await new Promise<void>((resolve, reject) => {
          const request = httpRequest(
            {
              socketPath: socket?.path,
              path,
              method: 'POST',
              headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
            },
            (response) => {
              response.resume();
              response.on('end', resolve);
            },
          );
          request.on('error', reject);
          request.end(body);
        });
      }

      expect(fake.requests).toHaveLength(2);
      assertNoSentinel(fake.requests.map((request) => request.body));
    });
  });
});
