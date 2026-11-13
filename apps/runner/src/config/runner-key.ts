import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { isEd25519PublicJwk, type Ed25519PublicJwk } from '@shared/contracts';
import { keysDirOf, runnerKeyPathOf } from './config';
import { RunnerFileError, ensurePrivateDir, readPrivateFile, writePrivateFile } from './private-files';

/**
 * The runner key (threat model C4 row 1): an Ed25519 key generated on the host at `enrol`, stored as a PKCS#8 PEM in
 * `keys/runner.key` 0600 under the runner's user. The console only ever sees the public JWK; the private half signs
 * every runner JWT and never leaves this file and the runner process.
 */

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

/** Writes the key 0600 into a 0700 `keys/`; refuses to replace an existing key. */
export async function saveRunnerKey(home: string, privateKey: KeyObject): Promise<void> {
  await ensurePrivateDir(keysDirOf(home));
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  await writePrivateFile(runnerKeyPathOf(home), typeof pem === 'string' ? pem : pem.toString('utf8'));
}

/** Loads the key after the 0600 check; anything but an Ed25519 private key is refused. */
export async function loadRunnerKey(home: string): Promise<KeyObject> {
  const pem = await readPrivateFile(runnerKeyPathOf(home));
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The parser's message can quote the file; the path is enough to act on.
    throw new RunnerFileError('file-unsafe', `${runnerKeyPathOf(home)} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new RunnerFileError('file-unsafe', `${runnerKeyPathOf(home)} is not an Ed25519 key`);
  }
  return key;
}
