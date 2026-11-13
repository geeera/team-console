import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_ID, RUNNER_ID } from '../testing/fake-console';
import {
  apiOriginOf,
  configPathOf,
  loadRunnerConfig,
  parseRunnerConfig,
  runnerHomeOf,
  runnerKeyPathOf,
  saveRunnerConfig,
  type RunnerConfig,
} from './config';
import { RunnerFileError, readPrivateFile, writePrivateFile } from './private-files';
import { generateRunnerKey, loadRunnerKey, saveRunnerKey } from './runner-key';

const config: RunnerConfig = {
  schema: 1,
  apiUrl: 'https://team-console-dev.geeera.workers.dev',
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  name: 'Owner Mac',
  audience: 'team-console:dev',
  allowedProjects: ['team-console'],
  pollSeconds: 60,
  backend: 'user',
};

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('runner config (ADR 0008 decision 2, threat model C4 row 1)', () => {
  let parent: string;
  let home: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-config-'));
    home = join(parent, 'home');
    await mkdir(home, { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  describe('TC_RUNNER_HOME', () => {
    it('defaults to ~/.team-console-runner', () => {
      expect(runnerHomeOf({}, '/Users/someone')).toBe('/Users/someone/.team-console-runner');
      expect(runnerHomeOf({ TC_RUNNER_HOME: '' }, '/Users/someone')).toBe(
        '/Users/someone/.team-console-runner',
      );
    });

    it('takes an absolute TC_RUNNER_HOME', () => {
      expect(runnerHomeOf({ TC_RUNNER_HOME: '/var/lib/tcrunner' }, '/Users/someone')).toBe(
        '/var/lib/tcrunner',
      );
    });

    it('refuses a relative TC_RUNNER_HOME', () => {
      expect(() => runnerHomeOf({ TC_RUNNER_HOME: 'runner-home' }, '/Users/someone')).toThrow(
        RunnerFileError,
      );
    });

    it.each([0o770, 0o777, 0o720, 0o702])(
      'refuses a home with mode %o (group/world-writable)',
      async (mode) => {
        await saveRunnerConfig(home, config);
        await chmod(home, mode);
        await expect(loadRunnerConfig(home)).rejects.toMatchObject({ problem: 'home-unsafe' });
      },
    );

    it('refuses a home that is a symlink', async () => {
      const link = join(parent, 'link');
      await symlink(home, link);
      await expect(loadRunnerConfig(link)).rejects.toMatchObject({ problem: 'home-unsafe' });
    });

    it.each([0o700, 0o750, 0o755])('accepts a home with mode %o (not writable by others)', async (mode) => {
      await saveRunnerConfig(home, config);
      await chmod(home, mode);
      await expect(loadRunnerConfig(home)).resolves.toEqual(config);
    });
  });

  describe('config.json', () => {
    it('is written 0600 and read back as it was', async () => {
      await saveRunnerConfig(home, config);
      expect(await modeOf(configPathOf(home))).toBe(0o600);
      await expect(loadRunnerConfig(home)).resolves.toEqual(config);
    });

    it('is never overwritten', async () => {
      await saveRunnerConfig(home, config);
      await expect(saveRunnerConfig(home, { ...config, name: 'Other' })).rejects.toMatchObject({
        problem: 'file-exists',
      });
      expect(JSON.parse(await readFile(configPathOf(home), 'utf8'))).toMatchObject({ name: 'Owner Mac' });
    });

    it.each([0o640, 0o604, 0o644, 0o660, 0o666])('refuses a config with mode %o', async (mode) => {
      await saveRunnerConfig(home, config);
      await chmod(configPathOf(home), mode);
      await expect(loadRunnerConfig(home)).rejects.toMatchObject({ problem: 'file-unsafe' });
    });

    it('refuses a config that is a symlink', async () => {
      const elsewhere = join(parent, 'elsewhere.json');
      await writeFile(elsewhere, JSON.stringify(config), { mode: 0o600 });
      await symlink(elsewhere, configPathOf(home));
      await expect(loadRunnerConfig(home)).rejects.toMatchObject({ problem: 'file-unsafe' });
    });

    it('says the config is missing on a home that was never enrolled', async () => {
      await expect(loadRunnerConfig(home)).rejects.toMatchObject({ problem: 'file-missing' });
    });

    it('refuses a config that is not JSON', async () => {
      await writePrivateFile(configPathOf(home), '{ not json');
      await expect(loadRunnerConfig(home)).rejects.toMatchObject({ problem: 'config-invalid' });
    });

    it.each<[string, Record<string, unknown>]>([
      ['an unknown key', { extra: true }],
      ['another schema', { schema: 2 }],
      ['a plain-http origin off loopback', { apiUrl: 'http://console.example' }],
      ['an origin with a path', { apiUrl: 'https://console.example/api' }],
      ['a runner id that is not a ULID', { runnerId: 'runner-1' }],
      ['an account id that is not a ULID', { accountId: 'owner' }],
      ['an empty name', { name: '' }],
      ['an audience of another shape', { audience: 'other:dev' }],
      ['a project that is not a slug', { allowedProjects: ['../x'] }],
      ['a poll interval below 5 s', { pollSeconds: 1 }],
      ['the actions-ephemeral backend', { backend: 'actions-ephemeral' }],
      ['an unknown backend', { backend: 'vm' }],
    ])('refuses %s', (_label, change) => {
      expect(() => parseRunnerConfig({ ...config, ...change })).toThrow(/config\.json/);
    });
  });

  describe('the console origin', () => {
    it.each([
      ['https://team-console-dev.geeera.workers.dev', 'https://team-console-dev.geeera.workers.dev'],
      ['https://console.example/', 'https://console.example'],
      ['https://console.example:8443', 'https://console.example:8443'],
      ['http://127.0.0.1:22300', 'http://127.0.0.1:22300'],
      ['http://localhost:8787', 'http://localhost:8787'],
      ['http://[::1]:8787', 'http://[::1]:8787'],
    ])('accepts %s', (value, origin) => {
      expect(apiOriginOf(value)).toBe(origin);
    });

    it.each([
      'http://console.example',
      'http://192.168.1.10:8787',
      'ftp://console.example',
      'https://user:pass@console.example',
      'https://console.example/api/v1',
      'https://console.example?x=1',
      'https://console.example#x',
      'console.example',
      '',
      'javascript:alert(1)',
    ])('refuses %s', (value) => {
      expect(apiOriginOf(value)).toBeNull();
    });
  });

  describe('runner key (keys/runner.key)', () => {
    it('is written 0600 in a 0700 keys directory and loads as the same Ed25519 key', async () => {
      const key = generateRunnerKey();
      await saveRunnerKey(home, key.privateKey);

      expect(await modeOf(runnerKeyPathOf(home))).toBe(0o600);
      expect(await modeOf(join(home, 'keys'))).toBe(0o700);
      expect((await readFile(runnerKeyPathOf(home), 'utf8')).startsWith('-----BEGIN PRIVATE KEY-----')).toBe(
        true,
      );
      const loaded = await loadRunnerKey(home);
      expect(loaded.asymmetricKeyType).toBe('ed25519');
      expect(loaded.export({ format: 'jwk' }).x).toBe(key.publicJwk.x);
    });

    it('posts only the public half: kty, crv and x, never d', () => {
      const { publicJwk } = generateRunnerKey();
      expect(Object.keys(publicJwk).sort()).toEqual(['crv', 'kty', 'x']);
      expect(publicJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    });

    it('is never replaced', async () => {
      await saveRunnerKey(home, generateRunnerKey().privateKey);
      await expect(saveRunnerKey(home, generateRunnerKey().privateKey)).rejects.toMatchObject({
        problem: 'file-exists',
      });
    });

    it.each([0o640, 0o604, 0o644])('refuses a key with mode %o', async (mode) => {
      await saveRunnerKey(home, generateRunnerKey().privateKey);
      await chmod(runnerKeyPathOf(home), mode);
      await expect(loadRunnerKey(home)).rejects.toMatchObject({ problem: 'file-unsafe' });
    });

    it('refuses a keys directory others can write', async () => {
      await mkdir(join(home, 'keys'), { mode: 0o700 });
      await chmod(join(home, 'keys'), 0o777);
      await expect(saveRunnerKey(home, generateRunnerKey().privateKey)).rejects.toMatchObject({
        problem: 'home-unsafe',
      });
    });

    it('refuses a file that is not an Ed25519 private key, without quoting it', async () => {
      await mkdir(join(home, 'keys'), { mode: 0o700 });
      await writePrivateFile(runnerKeyPathOf(home), 'not a key at all');
      const failure = loadRunnerKey(home);
      await expect(failure).rejects.toMatchObject({ problem: 'file-unsafe' });
      await expect(failure).rejects.not.toThrow(/not a key at all/);
    });
  });

  describe('private files', () => {
    it('writes 0600 even under a permissive umask', async () => {
      const previous = process.umask(0o000);
      try {
        await writePrivateFile(join(home, 'f'), 'x');
      } finally {
        process.umask(previous);
      }
      expect(await modeOf(join(home, 'f'))).toBe(0o600);
    });

    it('refuses to read a directory as a file', async () => {
      await mkdir(join(home, 'd'));
      await expect(readPrivateFile(join(home, 'd'))).rejects.toMatchObject({ problem: 'file-unsafe' });
    });
  });
});
