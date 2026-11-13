import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEd25519PublicJwk } from '@shared/contracts';
import { configPathOf, loadRunnerConfig, runnerKeyPathOf } from '../config/config';
import { loadRunnerKey, publicJwkOf } from '../config/runner-key';
import {
  ACCOUNT_ID,
  RUNNER_ID,
  fakeConsole,
  json,
  problem,
  sentinels,
  type FakeAnswer,
} from '../testing/fake-console';
import { RUNNER_VERSION } from '../version';
import { EnrolUsageError, checkEnrolOptions, enrol, hostFieldOf } from './enrol';

const API = 'http://127.0.0.1:22300';
const host = { os: 'darwin', arch: 'arm64', hostname: 'owner-mac.local' };
const enrolled = {
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  name: 'Owner Mac',
  audience: 'team-console:local',
  allowedProjects: ['team-console'],
  pollSeconds: 60,
};

describe('enrol --url --code --backend', () => {
  let parent: string;
  let home: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-enrol-'));
    home = join(parent, 'home');
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function enrolWith(answer: FakeAnswer, backend = 'user') {
    const fake = fakeConsole(answer);
    const result = enrol(
      { url: API, code: sentinels.enrolmentCode, backend },
      { home, fetch: fake.fetch, host },
    );
    return { result, requests: fake.requests };
  }

  it('posts the public key, host, capabilities, backend and version with the code, then writes key and config 0600', async () => {
    const { result, requests } = await enrolWith(() => json(201, enrolled));
    const config = await result;

    expect(config).toEqual({ schema: 1, apiUrl: API, backend: 'user', ...enrolled });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${API}/api/v1/runner/enrol`,
      method: 'POST',
      redirect: 'manual',
    });
    expect(requests[0]?.headers['authorization']).toBeUndefined();
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'capabilities',
      'code',
      'host',
      'isolation',
      'publicKey',
      'version',
    ]);
    expect(body).toMatchObject({
      code: sentinels.enrolmentCode,
      host,
      capabilities: { local: true, maxConcurrency: 1 },
      isolation: 'user',
      version: RUNNER_VERSION,
    });
    expect(isEd25519PublicJwk(body['publicKey'])).toBe(true);
    // No credential of any kind is described to the console (ADR 0008 decision 5).
    expect(Object.keys(body['capabilities'] as object).sort()).toEqual(['local', 'maxConcurrency']);

    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(configPathOf(home))).mode & 0o777).toBe(0o600);
    expect((await stat(runnerKeyPathOf(home))).mode & 0o777).toBe(0o600);
    await expect(loadRunnerConfig(home)).resolves.toEqual(config);
    expect(publicJwkOf(await loadRunnerKey(home))).toEqual(body['publicKey']);
  });

  it('writes nothing the code could be read from', async () => {
    const { result } = await enrolWith(() => json(201, enrolled));
    await result;
    for (const file of [configPathOf(home), runnerKeyPathOf(home)]) {
      expect(await readFile(file, 'utf8')).not.toContain(sentinels.enrolmentCode);
    }
  });

  it.each(['container', 'none'])('records the %s backend', async (backend) => {
    const { result, requests } = await enrolWith(() => json(201, enrolled), backend);
    await expect(result).resolves.toMatchObject({ backend });
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ isolation: backend });
  });

  describe('refusals before anything is sent or written', () => {
    it.each<[string, { url?: string; code?: string; backend?: string }, RegExp]>([
      ['a plain-http origin off loopback', { url: 'http://console.example' }, /--url/],
      ['a URL with a path', { url: 'https://console.example/api/v1' }, /--url/],
      ['a malformed code', { code: 'tce_short' }, /--code/],
      ['a job token as the code', { code: `tcj_${'J'.repeat(43)}` }, /--code/],
      ['the actions-ephemeral backend', { backend: 'actions-ephemeral' }, /--backend/],
      ['an unknown backend', { backend: 'vm' }, /--backend/],
    ])('%s', async (_label, change, message) => {
      const fake = fakeConsole(() => json(201, enrolled));
      const options = { url: API, code: sentinels.enrolmentCode, backend: 'user', ...change };

      await expect(enrol(options, { home, fetch: fake.fetch, host })).rejects.toThrow(message);
      await expect(enrol(options, { home, fetch: fake.fetch, host })).rejects.toBeInstanceOf(EnrolUsageError);
      expect(fake.requests).toEqual([]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('never echoes the code in a usage error', () => {
      const code = `tce_${'x'.repeat(10)}`;
      expect(() => checkEnrolOptions({ url: API, code, backend: 'user' })).toThrow(EnrolUsageError);
      try {
        checkEnrolOptions({ url: API, code, backend: 'user' });
      } catch (error: unknown) {
        expect(String(error)).not.toContain(code);
      }
    });

    it('a home others can write', async () => {
      await mkdir(home, { mode: 0o700 });
      await chmod(home, 0o777);
      const { result, requests } = await enrolWith(() => json(201, enrolled));

      await expect(result).rejects.toMatchObject({ problem: 'home-unsafe' });
      expect(requests).toEqual([]);
    });

    it('a home that is already enrolled (config.json present)', async () => {
      await (
        await enrolWith(() => json(201, enrolled))
      ).result;
      const { result, requests } = await enrolWith(() => json(201, { ...enrolled, name: 'Second' }));

      await expect(result).rejects.toMatchObject({ problem: 'file-exists' });
      expect(requests).toEqual([]);
      await expect(loadRunnerConfig(home)).resolves.toMatchObject({ name: 'Owner Mac' });
    });

    it('a home with a key but no config (a half-done enrolment)', async () => {
      await mkdir(join(home, 'keys'), { recursive: true, mode: 0o700 });
      await writeFile(runnerKeyPathOf(home), 'x', { mode: 0o600 });
      const { result, requests } = await enrolWith(() => json(201, enrolled));

      await expect(result).rejects.toMatchObject({ problem: 'file-exists' });
      expect(requests).toEqual([]);
    });
  });

  describe('refusals by the console leave the home empty', () => {
    it.each([
      [401, 'enrolment-code-invalid'],
      [422, 'runner-isolation-none'],
      [422, 'enrol-invalid'],
      [403, 'account-suspended'],
      [429, 'rate-limited'],
    ])('%i %s', async (status, slug) => {
      const { result } = await enrolWith(() => problem(status, slug));

      await expect(result).rejects.toMatchObject({ name: 'RunnerApiError', status, problem: slug });
      expect(await readdir(home)).toEqual([]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['no runner id', { ...enrolled, runnerId: undefined }],
      ['an audience of another shape', { ...enrolled, audience: 'evil' }],
      ['a project that is not a slug', { ...enrolled, allowedProjects: ['../x'] }],
      ['a poll interval out of range', { ...enrolled, pollSeconds: 0 }],
    ])('an answer with %s', async (_label, body) => {
      const { result } = await enrolWith(() => json(201, body));

      await expect(result).rejects.toThrow();
      expect(await readdir(home)).toEqual([]);
    });

    it('a 200 instead of 201', async () => {
      const { result } = await enrolWith(() => json(200, enrolled));
      await expect(result).rejects.toMatchObject({ status: 200 });
    });
  });

  it.each([
    ['  owner-mac.local  ', 'owner-mac.local'],
    ['', 'unknown'],
    ['x'.repeat(200), 'x'.repeat(128)],
  ])('describes the host field %j as %j', (value, expected) => {
    expect(hostFieldOf(value)).toBe(expected);
  });
});
