import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';

/**
 * File-system rules for what the runner keeps under `TC_RUNNER_HOME` (ADR 0008 decision 2, threat model C4 row 1):
 * the home and its directories belong to the runner's user and no one else may write them; `config.json` and every
 * file under `keys/` are 0600. A violation is refused, never repaired: a wider mode means someone may already have
 * read or replaced the file.
 */

export type RunnerFileProblem =
  'home-relative' | 'home-unsafe' | 'file-unsafe' | 'file-missing' | 'file-exists' | 'config-invalid';

export class RunnerFileError extends Error {
  constructor(
    readonly problem: RunnerFileProblem,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerFileError';
  }
}

/** Group or others may write. */
const SHARED_WRITE = 0o022;
/** Group or others may read, write or execute. */
const ANY_SHARED = 0o077;

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isErrnoException(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function describeMode(stats: Stats): string {
  return `0${(stats.mode & 0o777).toString(8)}`;
}

/**
 * A directory the runner may keep secrets in: a real directory (not a symlink), owned by the runner's user, and
 * writable by no one else. Created 0700 when missing; an existing one is judged as it is. `groupReadable` (0750) is
 * for what the `user` backend's job user must read (the mirror, the plugin, `jobs/`): set on a new and an existing
 * directory alike, after the ownership check.
 */
export async function ensurePrivateDir(path: string, mode: 0o700 | 0o750 | undefined = 0o700): Promise<void> {
  if ((await lstatOrNull(path)) === null) {
    await mkdir(path, { mode });
  }
  await assertPrivateDir(path);
  if (mode === 0o750) {
    await chmod(path, mode);
  }
}

export async function assertPrivateDir(path: string): Promise<void> {
  const stats = await lstatOrNull(path);
  if (stats === null || !stats.isDirectory()) {
    throw new RunnerFileError('home-unsafe', `${path} is not a directory (a symlink is refused too)`);
  }
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new RunnerFileError('home-unsafe', `${path} belongs to another user (uid ${String(stats.uid)})`);
  }
  if ((stats.mode & SHARED_WRITE) !== 0) {
    throw new RunnerFileError(
      'home-unsafe',
      `${path} is writable by group or others (${describeMode(stats)}); run chmod go-w on it and check what changed`,
    );
  }
}

/** Writes a new 0600 file; refuses one that already exists, so a key or a config is never silently replaced. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error: unknown) {
    if (isErrnoException(error, 'EEXIST')) {
      throw new RunnerFileError('file-exists', `${path} already exists`);
    }
    throw error;
  }
  try {
    // The umask cannot widen 0600, but it can narrow it; set it explicitly so the check on read always holds.
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Reads a file only when it is a regular file of the runner's user that no one else can read (0600 or tighter). */
export async function readPrivateFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isErrnoException(error, 'ENOENT')) {
      throw new RunnerFileError('file-missing', `${path} does not exist`);
    }
    if (isErrnoException(error, 'ELOOP')) {
      throw new RunnerFileError('file-unsafe', `${path} is a symlink`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new RunnerFileError('file-unsafe', `${path} is not a regular file`);
    }
    const uid = currentUid();
    if (uid !== null && stats.uid !== uid) {
      throw new RunnerFileError('file-unsafe', `${path} belongs to another user (uid ${String(stats.uid)})`);
    }
    if ((stats.mode & ANY_SHARED) !== 0) {
      throw new RunnerFileError(
        'file-unsafe',
        `${path} is readable or writable by group or others (${describeMode(stats)}); it must be 0600`,
      );
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}
