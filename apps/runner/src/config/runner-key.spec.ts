import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeKeychain } from '../testing/fake-keychain';
import { runnerKeyPathOf } from './config';
import { KEYCHAIN_SERVICE } from './keychain';
import { writePrivateFile } from './private-files';
import {
  RUNNER_KEY_STORE_ENV,
  generateRunnerKey,
  keychainAccountOf,
  loadRunnerKey,
  runnerKeyLocationOf,
  saveRunnerKey,
  type RunnerKeyDeps,
} from './runner-key';

describe('runner key store (#585)', () => {
  let parent: string;
  let home: string;
  let keychainFile: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-key-'));
    home = join(parent, 'home');
    await mkdir(home, { mode: 0o700 });
    keychainFile = join(parent, 'login.keychain-db');
    await writeFile(keychainFile, '');
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function macWith(
    options: Parameters<typeof fakeKeychain>[0] = { defaultKeychain: keychainFile },
    env = {},
  ) {
    const fake = fakeKeychain(options);
    const deps: RunnerKeyDeps = { platform: 'darwin', exec: fake.exec, env };
    return { ...fake, deps };
  }

  const itemKey = (account: string): string => `${keychainFile}\0${KEYCHAIN_SERVICE}\0${account}`;
  const xOf = (key: { export: (options: { format: 'jwk' }) => { x?: string } }): string | undefined =>
    key.export({ format: 'jwk' }).x;

  describe('macOS with a user keychain', () => {
    it('stores the key as a keychain item, writes no key file and loads the same Ed25519 key', async () => {
      const mac = macWith();
      const key = generateRunnerKey();

      await expect(saveRunnerKey(home, key.privateKey, mac.deps)).resolves.toBe('keychain');

      expect(mac.items.has(itemKey(await keychainAccountOf(home)))).toBe(true);
      await expect(stat(runnerKeyPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(home, 'keys'))).rejects.toMatchObject({ code: 'ENOENT' });
      const loaded = await loadRunnerKey(home, mac.deps);
      expect(loaded.asymmetricKeyType).toBe('ed25519');
      expect(xOf(loaded)).toBe(key.publicJwk.x);
    });

    it('never puts the secret in argv: the add goes to `security -i` on stdin, pinned to the keychain file', async () => {
      const mac = macWith();
      const key = generateRunnerKey();
      await saveRunnerKey(home, key.privateKey, mac.deps);
      const secret = mac.items.get(itemKey(await keychainAccountOf(home))) ?? '';

      expect(secret).not.toBe('');
      for (const call of mac.calls) {
        expect(call.command).toBe('/usr/bin/security');
        expect(call.args.join(' ')).not.toContain(secret);
      }
      const add = mac.calls.find((call) => call.args[0] === '-i');
      expect(add?.stdin).toContain(secret);
      expect(add?.stdin?.trim().endsWith(`"${keychainFile}"`)).toBe(true);
      expect(add?.stdin).toContain('-T /usr/bin/security');
    });

    it('refuses to replace an existing item', async () => {
      const mac = macWith();
      await saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps);

      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps)).rejects.toMatchObject({
        problem: 'file-exists',
      });
      await expect(runnerKeyLocationOf(home, mac.deps)).resolves.toContain(await keychainAccountOf(home));
    });

    it('keeps one item per runner home', async () => {
      const mac = macWith();
      const other = join(parent, 'other');
      await mkdir(other, { mode: 0o700 });
      const first = generateRunnerKey();
      const second = generateRunnerKey();
      await saveRunnerKey(home, first.privateKey, mac.deps);
      await saveRunnerKey(other, second.privateKey, mac.deps);

      expect(xOf(await loadRunnerKey(home, mac.deps))).toBe(first.publicJwk.x);
      expect(xOf(await loadRunnerKey(other, mac.deps))).toBe(second.publicJwk.x);
    });

    it('refuses when neither the item nor the file exists, naming both', async () => {
      const mac = macWith();
      const failure = loadRunnerKey(home, mac.deps);

      await expect(failure).rejects.toMatchObject({ problem: 'file-missing' });
      await expect(failure).rejects.toThrow(await keychainAccountOf(home));
      await expect(failure).rejects.toThrow(runnerKeyPathOf(home));
    });

    it('refuses a locked or unreachable keychain instead of falling back to a file', async () => {
      const mac = macWith({ defaultKeychain: keychainFile, failWith: 36 });

      await expect(loadRunnerKey(home, mac.deps)).rejects.toMatchObject({ problem: 'key-unavailable' });
      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps)).rejects.toMatchObject({
        problem: 'key-unavailable',
      });
      await expect(stat(runnerKeyPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses an add the keychain did not keep', async () => {
      const mac = macWith({ defaultKeychain: keychainFile, dropAdds: true });

      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps)).rejects.toMatchObject({
        problem: 'key-unavailable',
      });
    });

    it('resolves a symlinked TC_RUNNER_HOME to the same account as its target (realpath, not resolve)', async () => {
      const mac = macWith();
      const link = join(parent, 'home-link');
      await symlink(home, link);
      const key = generateRunnerKey();

      await saveRunnerKey(link, key.privateKey, mac.deps);

      expect(await keychainAccountOf(link)).toBe(await keychainAccountOf(home));
      expect(xOf(await loadRunnerKey(home, mac.deps))).toBe(key.publicJwk.x);
    });

    it('refuses an item that is not an Ed25519 PKCS#8 key, without quoting it', async () => {
      const mac = macWith();
      mac.items.set(itemKey(await keychainAccountOf(home)), Buffer.from('not a key at all').toString('base64'));
      const failure = loadRunnerKey(home, mac.deps);

      await expect(failure).rejects.toMatchObject({ problem: 'file-unsafe' });
      await expect(failure).rejects.not.toThrow(/not a key at all/);
    });
  });

  describe('migration from an existing keys/runner.key', () => {
    async function legacyKeyFile() {
      const key = generateRunnerKey();
      await saveRunnerKey(home, key.privateKey, {
        platform: 'linux',
        exec: fakeKeychain({ defaultKeychain: null }).exec,
        env: {},
      });
      return key;
    }

    it('moves the 0600 file into the keychain on load, then deletes the file', async () => {
      const key = await legacyKeyFile();
      const mac = macWith();

      expect(xOf(await loadRunnerKey(home, mac.deps))).toBe(key.publicJwk.x);
      await expect(stat(runnerKeyPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mac.items.has(itemKey(await keychainAccountOf(home)))).toBe(true);
      expect(xOf(await loadRunnerKey(home, mac.deps))).toBe(key.publicJwk.x);
    });

    it('keeps the file when the keychain did not keep the item', async () => {
      await legacyKeyFile();
      const mac = macWith({ defaultKeychain: keychainFile, dropAdds: true });

      await expect(loadRunnerKey(home, mac.deps)).rejects.toMatchObject({ problem: 'key-unavailable' });
      expect((await readFile(runnerKeyPathOf(home), 'utf8')).startsWith('-----BEGIN PRIVATE KEY-----')).toBe(
        true,
      );
    });

    it('applies the 0600 check before moving a file', async () => {
      await legacyKeyFile();
      await chmod(runnerKeyPathOf(home), 0o644);
      const mac = macWith();

      await expect(loadRunnerKey(home, mac.deps)).rejects.toMatchObject({ problem: 'file-unsafe' });
      expect(mac.items.size).toBe(0);
    });

    it('finishes an interrupted move: a file holding the same key as the item is deleted', async () => {
      const key = await legacyKeyFile();
      const mac = macWith();
      const pem = await readFile(runnerKeyPathOf(home), 'utf8');
      await loadRunnerKey(home, mac.deps);
      await writePrivateFile(runnerKeyPathOf(home), pem);

      expect(xOf(await loadRunnerKey(home, mac.deps))).toBe(key.publicJwk.x);
      await expect(stat(runnerKeyPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a file and an item that hold different keys, and deletes neither', async () => {
      const mac = macWith();
      await saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps);
      await mkdir(join(home, 'keys'), { mode: 0o700 });
      const other = generateRunnerKey().privateKey.export({ format: 'pem', type: 'pkcs8' });
      await writePrivateFile(
        runnerKeyPathOf(home),
        typeof other === 'string' ? other : other.toString('utf8'),
      );

      await expect(loadRunnerKey(home, mac.deps)).rejects.toThrow(/hold different keys/);
      await expect(stat(runnerKeyPathOf(home))).resolves.toBeDefined();
      expect(mac.items.size).toBe(1);
    });

    it('reports a legacy file as the existing key, so enrol refuses before it sends anything', async () => {
      await legacyKeyFile();
      await expect(runnerKeyLocationOf(home, macWith().deps)).resolves.toBe(runnerKeyPathOf(home));
    });
  });

  describe('the 0600 file fallback', () => {
    it('is used on Linux without calling security', async () => {
      const fake = fakeKeychain({ defaultKeychain: keychainFile });
      const deps: RunnerKeyDeps = { platform: 'linux', exec: fake.exec, env: {} };

      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, deps)).resolves.toBe('file');
      expect((await stat(runnerKeyPathOf(home))).mode & 0o777).toBe(0o600);
      await expect(loadRunnerKey(home, deps)).resolves.toBeDefined();
      expect(fake.calls).toEqual([]);
    });

    it('is used on macOS for a user with no keychain (the user backend’s _tcrunner)', async () => {
      const mac = macWith({ defaultKeychain: null });

      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps)).resolves.toBe('file');
      expect((await stat(runnerKeyPathOf(home))).mode & 0o777).toBe(0o600);
      await expect(loadRunnerKey(home, mac.deps)).resolves.toBeDefined();
    });

    it('is used on macOS when the default keychain names a file that does not exist', async () => {
      const mac = macWith({ defaultKeychain: join(parent, 'missing.keychain-db') });
      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps)).resolves.toBe('file');
    });

    it(`is pinned by ${RUNNER_KEY_STORE_ENV}=file, which never calls security`, async () => {
      const mac = macWith(undefined, { [RUNNER_KEY_STORE_ENV]: 'file' });

      await expect(saveRunnerKey(home, generateRunnerKey().privateKey, mac.deps)).resolves.toBe('file');
      expect(mac.calls).toEqual([]);
    });
  });

  describe(`${RUNNER_KEY_STORE_ENV}`, () => {
    it('=keychain refuses a host without a keychain instead of writing a file', async () => {
      const mac = macWith({ defaultKeychain: null }, { [RUNNER_KEY_STORE_ENV]: 'keychain' });
      const linux: RunnerKeyDeps = {
        platform: 'linux',
        exec: fakeKeychain({ defaultKeychain: null }).exec,
        env: { [RUNNER_KEY_STORE_ENV]: 'keychain' },
      };

      for (const deps of [mac.deps, linux]) {
        await expect(saveRunnerKey(home, generateRunnerKey().privateKey, deps)).rejects.toMatchObject({
          problem: 'key-unavailable',
        });
        await expect(loadRunnerKey(home, deps)).rejects.toMatchObject({ problem: 'key-unavailable' });
      }
      await expect(stat(runnerKeyPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses an unknown value', async () => {
      const mac = macWith(undefined, { [RUNNER_KEY_STORE_ENV]: 'vault' });
      await expect(loadRunnerKey(home, mac.deps)).rejects.toMatchObject({ problem: 'key-unavailable' });
    });
  });
});
