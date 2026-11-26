import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** A directory of the stack only its owner may list, enter or write to. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * `dir` as it is, without following a link, and an error unless it is a directory itself: behind a symbolic link the
 * stack would read, write and `chmod` whatever the link names (#1006).
 */
export function realDirectory(dir: string): Stats {
  const entry = lstatSync(dir);
  if (entry.isSymbolicLink()) {
    throw new Error(`${dir} is a symbolic link: the stack only uses directories of its own. Remove it.`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${dir} is not a directory: the stack cannot keep its files there. Remove it.`);
  }
  return entry;
}

/**
 * Makes `dir` a directory of this user only (#1013). `mkdir` applies its mode only to a directory it creates, so one
 * that is already there — made by hand, or by an older checkout — is tightened as well (#999), when it is ours: a
 * link or another user's directory is refused, not used.
 *
 * The parent has to be there: whoever cannot trust the path above `dir` checks it first (`privateDirectoryBelow`),
 * and a parent made here would skip that check (#1019).
 *
 * `lstat` gives the clear error for a link. The owner is then read, and the mode set, through one descriptor opened
 * without following links (#1019): both apply to the very directory that was opened, and a link swapped in after the
 * `lstat` is refused by the system instead of being followed.
 */
export function privateDirectory(dir: string): void {
  makeDirectory(dir, PRIVATE_DIRECTORY_MODE);
  realDirectory(dir);
  const descriptor = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const user = process.getuid?.();
    if (user !== undefined && opened.uid !== user) {
      throw new Error(
        `${dir} belongs to another user (uid ${opened.uid}): the stack cannot make it its own.`,
      );
    }
    fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Every directory below `root` down to `dir`, made with the default mode where missing, each checked to be a real
 * directory before the next one is made in it (#1013): nothing is created behind a link on the way. `root` itself is
 * trusted (the checkout); `dir` keeps its mode, as logs live there too.
 */
export function realDirectoriesBelow(root: string, dir: string): void {
  for (const below of directoriesBelow(root, dir)) {
    makeDirectory(below);
    realDirectory(below);
  }
}

/** `realDirectoriesBelow` down to the parent of `dir`, then `dir` itself for its owner only (`privateDirectory`). */
export function privateDirectoryBelow(root: string, dir: string): void {
  const directories = directoriesBelow(root, dir);
  for (const above of directories.slice(0, -1)) {
    makeDirectory(above);
    realDirectory(above);
  }
  privateDirectory(dir);
}

/** Every directory on the way from `root` down to `dir`, `root` left out and `dir` last. */
function directoriesBelow(root: string, dir: string): string[] {
  const below = relative(root, dir);
  if (below === '' || isAbsolute(below) || below.split(sep).includes('..')) {
    throw new Error(
      `${dir} is not below ${root}: the stack cannot tell which directories on the way are its own.`,
    );
  }
  const directories: string[] = [];
  let path = root;
  for (const name of below.split(sep)) {
    path = join(path, name);
    directories.push(path);
  }
  return directories;
}

/** `mkdir` of `dir` alone; an entry already there is left for `realDirectory` to judge. */
function makeDirectory(dir: string, mode?: number): void {
  try {
    mkdirSync(dir, mode === undefined ? undefined : { mode });
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
}
