import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerKeyFingerprintOf, type Ed25519PublicJwk } from '@shared/contracts';
import { loadRunnerConfig } from '../config/config';
import { ACCOUNT_ID, RUNNER_ID, fakeConsole, json, problem, sentinels, type RecordedRequest } from '../testing/fake-console';
import { EnrolIntentError, enrol } from './enrol';

const API = 'http://127.0.0.1:22300';
const INTENT = '01JC00000000000000000000Q1';
const host = { os: 'darwin', arch: 'arm64', hostname: 'owner-mac.local' };
const POLL_TOKEN = `tcep_${'P'.repeat(43)}`;
const enrolled = {
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  name: 'Owner Mac',
  audience: 'team-console:local',
  projectScope: 'all',
  allowedProjects: [],
  pollSeconds: 60,
};

const bodyOf = (request: RecordedRequest): Record<string, unknown> =>
  JSON.parse(request.body ?? '{}') as Record<string, unknown>;

describe('enrol --enrolment (#634 PR 2, R-INT-1)', () => {
  let parent: string;
  let home: string;
  let out: string[];
  let slept: number[];

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-intent-'));
    home = join(parent, 'home');
    out = [];
    slept = [];
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function runEnrol(fetch: ReturnType<typeof fakeConsole>['fetch'], now = '2026-11-21T10:01:00.000Z') {
    return enrol(
      { url: API, enrolment: INTENT, backend: 'user', credential: 'setup-token' },
      {
        home,
        fetch,
        host,
        out: (line) => out.push(line),
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        now: () => new Date(now),
      },
    );
  }

  /** A fetch that answers `start` with the key's real fingerprint (computed when the request arrives). */
  function honestConsole(pendingPolls = 2, lie?: string) {
    const requests: RecordedRequest[] = [];
    let polls = 0;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const request: RecordedRequest = { url, method: init.method ?? 'GET', headers: {}, body: init.body as string, redirect: init.redirect };
      requests.push(request);
      if (url.endsWith('/enrol/start')) {
        const publicKey = bodyOf(request)['publicKey'] as Ed25519PublicJwk;
        return json(200, {
          pollToken: POLL_TOKEN,
          fingerprint: lie ?? (await runnerKeyFingerprintOf(publicKey)),
          intervalSeconds: 5,
          expiresAt: '2026-11-21T10:10:00.000Z',
          accountName: 'Geeera\u001b[31m',
        });
      }
      polls += 1;
      if (polls <= pendingPolls) {
        return polls === 1 ? problem(429, 'slow-down') : json(202, { state: 'bound', intervalSeconds: 5 });
      }
      return json(200, enrolled);
    };
    return { fetch, requests };
  }

  it('binds, prints the fingerprint it computed, polls at the interval and writes key and config once approved', async () => {
    const { fetch, requests } = honestConsole();
    const config = await runEnrol(fetch);
    expect(config).toMatchObject({ runnerId: RUNNER_ID, projectScope: 'all', credential: { kind: 'setup-token' } });
    await expect(loadRunnerConfig(home)).resolves.toMatchObject({ runnerId: RUNNER_ID });

    const start = bodyOf(requests[0] as RecordedRequest);
    expect(Object.keys(start).sort()).toEqual(['capabilities', 'host', 'intentId', 'isolation', 'publicKey', 'version']);
    expect(start).toMatchObject({ intentId: INTENT, isolation: 'user', capabilities: { accessSources: ['subscription'] } });
    const fingerprint = await runnerKeyFingerprintOf(start['publicKey'] as Ed25519PublicJwk);
    // The account name is console text: no escape sequence reaches the terminal.
    expect(out).toEqual([
      'Request sent to account «Geeera[31m».',
      `Compare this code with the one in the console, then press «Подтвердить» (Approve) there: ${fingerprint}`,
    ]);
    expect(requests.slice(1).map((request) => bodyOf(request))).toEqual([
      { intentId: INTENT, pollToken: POLL_TOKEN },
      { intentId: INTENT, pollToken: POLL_TOKEN },
      { intentId: INTENT, pollToken: POLL_TOKEN },
    ]);
    expect(slept).toEqual([5000, 5000, 5000]);
    // No request carries the poll token anywhere but its body, nor any credential.
    for (const request of requests) {
      expect(request.url).not.toContain(POLL_TOKEN);
      expect(request.body ?? '').not.toMatch(/sk-ant-|setup-token|api-key/);
    }
  });

  it('refuses a console that names another fingerprint, writing nothing', async () => {
    const { fetch, requests } = honestConsole(0, '0000-0000');
    await expect(runEnrol(fetch)).rejects.toThrow(/console names another key \(0000-0000\).*Отклонить/);
    expect(requests).toHaveLength(1);
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it('says loudly that another machine took the request (409), writing nothing', async () => {
    const taken = fakeConsole(() => problem(409, 'enrolment-intent-bound'));
    const failure = runEnrol(taken.fetch);
    await expect(failure).rejects.toBeInstanceOf(EnrolIntentError);
    await expect(failure).rejects.toThrow(/ALREADY TAKEN BY ANOTHER MACHINE.*Отклонить/);
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it.each(['start', 'poll'] as const)('turns a 404 on %s into "start again", writing nothing', async (where) => {
    const { fetch } = honestConsole(0);
    const gone = async (url: string, init: RequestInit): Promise<Response> =>
      url.endsWith(`/enrol/${where}`) ? problem(404, 'enrolment-not-found') : await fetch(url, init);
    await expect(runEnrol(gone)).rejects.toThrow(/start again from Settings › Runners › Add runner/);
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it('gives up once the request is past its collection window', async () => {
    const { fetch } = honestConsole(1000);
    await expect(runEnrol(fetch, '2026-11-21T10:13:00.000Z')).rejects.toThrow(/expired before it was approved/);
  });

  it('refuses a request id that is not one, before any request', async () => {
    const fake = fakeConsole(() => json(500, {}));
    await expect(
      enrol({ url: API, enrolment: 'not-an-id', backend: 'user' }, { home, fetch: fake.fetch, host }),
    ).rejects.toThrow(/--enrolment must be the request id/);
    await expect(
      enrol({ url: API, enrolment: INTENT, code: sentinels.enrolmentCode, backend: 'user' }, { home, fetch: fake.fetch, host }),
    ).rejects.toThrow(/not both or neither/);
    expect(fake.requests).toHaveLength(0);
  });
});
