import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { isEd25519PublicJwk, type Ed25519PublicJwk } from '@shared/contracts';
import { hostExec, type Exec } from '../host/exec';
import { keysDirOf, runnerKeyPathOf } from './config';
import { KeychainError, openUserKeychain, type Keychain } from './keychain';
import {
  RunnerFileError,
  ensurePrivateDir,
  pathExists,
  readPrivateFile,
  writePrivateFile,
} from './private-files';

/**
 * The runner key (threat model C4 row 1): an Ed25519 key generated on the host at `enrol`. The console only ever sees
 * the public JWK; the private half signs every runner JWT and never leaves its store and the runner process.
 *
 * Where it is stored (#585): on macOS, in the default keychain of the runner's user when that user has one, as a
 * base64 PKCS#8 generic-password item (service `team-console-runner`, account `runner-key:<home>`) — encrypted at rest
 * and never a plaintext file. Elsewhere, and for a macOS service user with no keychain (`_tcrunner` of the `user`
 * backend: a LaunchDaemon user that never logs in), it is the PKCS#8 PEM `keys/runner.key` 0600 under the runner's
 * user, as before. A keychain the runner would have to unlock with a password kept next to it protects nothing a
 * 0600 file does not, so none is created. `TC_RUNNER_KEY_STORE=keychain|file` pins the choice: `keychain` refuses
 * rather than fall back, `file` never touches the keychain.
 */

export const RUNNER_KEY_STORE_ENV = 'TC_RUNNER_KEY_STORE';
export const RUNNER_KEY_LABEL = 'Team Console runner key';

export type RunnerKeyStoreKind = 'keychain' | 'file';

export interface RunnerKeyDeps {
  readonly platform: NodeJS.Platform | string;
  readonly exec: Exec;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const hostDeps = (): RunnerKeyDeps => ({ platform: process.platform, exec: hostExec, env: process.env });

export interface RunnerKeyPair {
  readonly privateKey: KeyObject;
  readonly publicJwk: Ed25519PublicJwk;
}

export function publicJwkOf(privateKey: KeyObject): Ed25519PublicJwk {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const candidate = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  if (!isEd25519PublicJwk(candidate)) {
    throw new Error('the runner key is not an Ed25519 key');
  }
  return candidate;
}

export function generateRunnerKey(): RunnerKeyPair {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicJwk: publicJwkOf(privateKey) };
}

/**
 * One item per runner home, so two homes of one user never share a key. Resolved with `realpath`, not `resolve`:
 * a symlinked `TC_RUNNER_HOME` must map to the same account as its target, or a key saved through the link and
 * loaded through the target (or the reverse) would look like two different homes. A home that does not exist
 * (`realpath` raises `ENOENT`) is reported as the key store being unavailable, never as a raw filesystem error.
 */
export async function keychainAccountOf(home: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(home);
  } catch (error: unknown) {
    throw unavailable(error);
  }
  return `runner-key:${real}`;
}

function unavailable(error: unknown): RunnerFileError {
  if (error instanceof RunnerFileError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : 'failed';
  return new RunnerFileError('key-unavailable', `the runner key's keychain: ${detail}`);
}

/**
 * The keychain this home's key belongs in, or null for the 0600 file. Unset: the user's keychain on macOS when it has
 * one. An unknown value is refused, never guessed.
 */
async function keychainOf(deps: RunnerKeyDeps): Promise<Keychain | null> {
  const pinned = deps.env[RUNNER_KEY_STORE_ENV];
  if (pinned !== undefined && pinned !== '' && pinned !== 'keychain' && pinned !== 'file') {
    throw new RunnerFileError('key-unavailable', `${RUNNER_KEY_STORE_ENV} must be keychain or file`);
  }
  if (pinned === 'file') {
    return null;
  }
  let keychain: Keychain | null = null;
  if (deps.platform === 'darwin') {
    try {
      keychain = await openUserKeychain(deps.exec);
    } catch (error: unknown) {
      throw unavailable(error);
    }
  }
  if (keychain === null && pinned === 'keychain') {
    throw new RunnerFileError(
      'key-unavailable',
      `${RUNNER_KEY_STORE_ENV}=keychain, but this user has no macOS keychain the runner can use; unset it to keep the key in keys/runner.key 0600`,
    );
  }
  return keychain;
}

function encodeForKeychain(privateKey: KeyObject): string {
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

function ed25519Of(key: KeyObject, where: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new RunnerFileError('file-unsafe', `${where} is not an Ed25519 key`);
  }
  return key;
}

function keyFromPem(pem: string, home: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The parser's message can quote the file; the path is enough to act on.
    throw new RunnerFileError('file-unsafe', `${runnerKeyPathOf(home)} is not a PEM private key`);
  }
  return ed25519Of(key, runnerKeyPathOf(home));
}

async function keyFromKeychain(secret: string, keychain: Keychain, home: string): Promise<KeyObject> {
  const where = `the keychain item ${await keychainAccountOf(home)} in ${keychain.path}`;
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new RunnerFileError('file-unsafe', `${where} is not a PKCS#8 private key`);
  }
  return ed25519Of(key, where);
}

const sameKey = (a: KeyObject, b: KeyObject): boolean => encodeForKeychain(a) === encodeForKeychain(b);

/** Adds the item and reads it back, so a key is never reported stored when the keychain did not keep it. */
async function storeInKeychain(keychain: Keychain, home: string, privateKey: KeyObject): Promise<void> {
  const account = await keychainAccountOf(home);
  try {
    await keychain.add(account, encodeForKeychain(privateKey), RUNNER_KEY_LABEL);
    const stored = await keychain.read(account);
    if (stored === null || !sameKey(await keyFromKeychain(stored, keychain, home), privateKey)) {
      throw new KeychainError(`${keychain.path} did not keep the item ${account}`);
    }
  } catch (error: unknown) {
    throw error instanceof RunnerFileError ? error : unavailable(error);
  }
}

async function readKeychainItem(keychain: Keychain, home: string): Promise<string | null> {
  try {
    return await keychain.read(await keychainAccountOf(home));
  } catch (error: unknown) {
    throw unavailable(error);
  }
}

/** Where an existing key of this home is, or null; `enrol` asks before it registers anything with the console. */
export async function runnerKeyLocationOf(
  home: string,
  deps: RunnerKeyDeps = hostDeps(),
): Promise<string | null> {
  if (await pathExists(runnerKeyPathOf(home))) {
    return runnerKeyPathOf(home);
  }
  const keychain = await keychainOf(deps);
  if (keychain !== null && (await readKeychainItem(keychain, home)) !== null) {
    return `the keychain item ${await keychainAccountOf(home)} in ${keychain.path}`;
  }
  return null;
}

/** Stores a new key in the keychain or 0600 into a 0700 `keys/`; refuses to replace an existing key in either. */
export async function saveRunnerKey(
  home: string,
  privateKey: KeyObject,
  deps: RunnerKeyDeps = hostDeps(),
): Promise<RunnerKeyStoreKind> {
  const keychain = await keychainOf(deps);
  if (keychain === null) {
    await ensurePrivateDir(keysDirOf(home));
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    await writePrivateFile(runnerKeyPathOf(home), typeof pem === 'string' ? pem : pem.toString('utf8'));
    return 'file';
  }
  const existing = await runnerKeyLocationOf(home, deps);
  if (existing !== null) {
    throw new RunnerFileError('file-exists', `${existing} already exists`);
  }
  await storeInKeychain(keychain, home, privateKey);
  return 'keychain';
}

/**
 * Loads the key; anything but an Ed25519 private key is refused. With a keychain, a `keys/runner.key` left by an
 * older release is moved into it (written, read back, then the file deleted); a file next to an item that holds the
 * same key is the tail of an interrupted move and is deleted, one that holds another key is refused.
 */
export async function loadRunnerKey(home: string, deps: RunnerKeyDeps = hostDeps()): Promise<KeyObject> {
  const keychain = await keychainOf(deps);
  const path = runnerKeyPathOf(home);
  if (keychain === null) {
    return keyFromPem(await readPrivateFile(path), home);
  }
  const secret = await readKeychainItem(keychain, home);
  const hasFile = await pathExists(path);
  if (secret === null && !hasFile) {
    throw new RunnerFileError(
      'file-missing',
      `no runner key: neither the keychain item ${await keychainAccountOf(home)} in ${keychain.path} nor ${path} exists`,
    );
  }
  // The file's 0600 checks apply before its content is trusted, also on the way into the keychain.
  const fromFile = hasFile ? keyFromPem(await readPrivateFile(path), home) : null;
  if (secret === null) {
    if (fromFile !== null) {
      await storeInKeychain(keychain, home, fromFile);
      await rm(path);
    }
    return requireKey(fromFile, path);
  }
  const key = await keyFromKeychain(secret, keychain, home);
  if (fromFile !== null) {
    if (!sameKey(key, fromFile)) {
      throw new RunnerFileError(
        'file-unsafe',
        `${path} and the keychain item ${await keychainAccountOf(home)} hold different keys; revoke the runner and enrol again`,
      );
    }
    await rm(path);
  }
  return key;
}

function requireKey(key: KeyObject | null, path: string): KeyObject {
  if (key === null) {
    throw new RunnerFileError('file-missing', `${path} does not exist`);
  }
  return key;
}
