import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

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
 * link or another user's directory is refused, not used. Missing parents are made with the default mode.
 *
 * `lstat` gives the clear error; the mode is then set through a descriptor opened without following links, so a link
 * swapped in after the check is refused by the system as well instead of being followed. Only `dir` itself is
 * checked: a caller that cannot trust the path above it checks that first (`stackHome`).
 */
export function privateDirectory(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const entry = realDirectory(dir);
  const user = process.getuid?.();
  if (user !== undefined && entry.uid !== user) {
    throw new Error(`${dir} belongs to another user (uid ${entry.uid}): the stack cannot make it its own.`);
  }
  const descriptor = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
  } finally {
    closeSync(descriptor);
  }
}
