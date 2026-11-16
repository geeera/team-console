import { lstat } from 'node:fs/promises';
import type { Exec } from '../host/exec';

/**
 * The macOS Keychain through Apple's `security` CLI (#585): no native addon and no new dependency. Every call names
 * one keychain file explicitly, because `security` silently falls back to the default keychain when the named one is
 * missing. The secret never travels in argv (`ps` shows argv to every local user): `add` goes through `security -i`,
 * which reads the command from stdin, and `find -w` prints it to our stdout only.
 */

export const SECURITY_CLI = '/usr/bin/security';
export const KEYCHAIN_SERVICE = 'team-console-runner';

/** `errSecItemNotFound` and `errSecDuplicateItem` as `security` reports them in its exit code. */
const EXIT_NOT_FOUND = 44;
const EXIT_DUPLICATE = 45;

/** What `security -i` would split or unescape; such a path or account is refused rather than quoted. */
const UNQUOTABLE = /["\\\p{Cc}]/u;
/** The secrets stored here are base64 (a DER key), so nothing in them needs quoting either. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

export interface Keychain {
  /** The keychain file every call is pinned to. */
  readonly path: string;
  /** The item's secret, or null when this keychain has no such item. */
  read(account: string): Promise<string | null>;
  /** Adds a new item; an existing one is never replaced. */
  add(account: string, secret: string, label: string): Promise<void>;
  /** Removes the item; false when there was none. */
  remove(account: string): Promise<boolean>;
}

function assertQuotable(what: string, value: string): void {
  if (value === '' || UNQUOTABLE.test(value)) {
    throw new KeychainError(
      `the keychain ${what} has a character the security CLI cannot take: ${JSON.stringify(value)}`,
    );
  }
}

/** `security default-keychain` prints the path indented and double-quoted. */
export function parseKeychainPath(stdout: string): string | null {
  const match = /^\s*"([^"]+)"\s*$/.exec(stdout);
  return match?.[1] ?? null;
}

/**
 * The default keychain of the user this process runs as, or null when it has none — e.g. a service user that never
 * logged in, such as the `user` backend's `_tcrunner`. A path `security` names but that does not exist counts as none.
 */
export async function openUserKeychain(exec: Exec): Promise<Keychain | null> {
  const result = await exec(SECURITY_CLI, ['default-keychain', '-d', 'user']);
  if (result.code !== 0) {
    return null;
  }
  const path = parseKeychainPath(result.stdout);
  if (path === null) {
    return null;
  }
  try {
    if (!(await lstat(path)).isFile()) {
      return null;
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  assertQuotable('path', path);
  return keychainAt(path, exec);
}

export function keychainAt(path: string, exec: Exec): Keychain {
  const failed = (action: string, code: number | null): KeychainError =>
    new KeychainError(
      `security ${action} on ${path} failed (exit ${String(code)}); is the keychain locked or unreachable from this session?`,
    );

  return {
    path,
    async read(account) {
      assertQuotable('account', account);
      const result = await exec(SECURITY_CLI, [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        account,
        '-w',
        path,
      ]);
      if (result.code === EXIT_NOT_FOUND) {
        return null;
      }
      if (result.code !== 0) {
        throw failed('find-generic-password', result.code);
      }
      return result.stdout.replace(/\n$/, '');
    },
    async add(account, secret, label) {
      assertQuotable('account', account);
      assertQuotable('label', label);
      if (!BASE64.test(secret)) {
        throw new KeychainError('only a base64 secret is stored in the keychain');
      }
      // -T trusts only Apple's `security` (the reader); without -U an existing item makes the add fail.
      const command = [
        'add-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        `"${account}"`,
        '-l',
        `"${label}"`,
        '-T',
        SECURITY_CLI,
        '-w',
        secret,
        `"${path}"`,
      ].join(' ');
      const result = await exec(SECURITY_CLI, ['-i'], { stdin: `${command}\n` });
      if (result.code === EXIT_DUPLICATE) {
        throw new KeychainError(`${path} already holds a ${KEYCHAIN_SERVICE} item for ${account}`);
      }
      if (result.code !== 0) {
        throw failed('add-generic-password', result.code);
      }
    },
    async remove(account) {
      assertQuotable('account', account);
      const result = await exec(SECURITY_CLI, [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        account,
        path,
      ]);
      if (result.code === EXIT_NOT_FOUND) {
        return false;
      }
      if (result.code !== 0) {
        throw failed('delete-generic-password', result.code);
      }
      return true;
    },
  };
}
