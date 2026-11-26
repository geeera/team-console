import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  BUNDLE_FILE,
  NODE_FILE,
  RELEASE_FILES,
  RELEASE_SUMS_FILE,
  runnerReleaseChannelOf,
} from '@shared/contracts';

/**
 * The install directory `update` maintains (#604): each release in its own `releases/<version>/`, one `current`
 * symlink naming the live one, and `team-console-runner.mjs`, `SHA256SUMS` and each file of `bin/` as fixed symlinks
 * through it. Switching releases is then one `rename` of `current`, so a crash leaves either the old release or the
 * new one, never a mix: the bundle and the `node` that runs it (#634 PR 5) change in the same rename. The service and
 * the sudoers rule keep naming `<prefix>/node`, `<prefix>/team-console-runner.mjs` and `<prefix>/bin/job-exec`. A tarball extracted by hand (the documented first install) is flat; the first `update`
 * converts it.
 *
 * `bin` stays a real directory whose entries are the links (#666): a directory cannot be renamed over by a link, so
 * linking `bin` itself would need a moment with no `bin/job-exec` at all, and a crash there leaves the launcher and
 * `job-exec` missing. Replacing one file with a link is one atomic rename, so `bin/job-exec` exists at every step.
 * A prefix whose `bin` is already one symlink through `current` (the first layout) is left as it is.
 */

export const RELEASES_DIR = 'releases';
export const CURRENT_LINK = 'current';

/** `releases/<version>`, relative so the prefix stays movable. */
export const releaseDirOf = (version: string): string => join(RELEASES_DIR, version);

export const BIN_DIR = 'bin';

/** The file names inside `bin/` that a release holds. */
export const BIN_FILES: readonly string[] = RELEASE_FILES.filter((file) =>
  file.startsWith(`${BIN_DIR}/`),
).map((file) => basename(file));

/** Relative to `bin/`, so the prefix stays movable. */
export const binLinkTargetOf = (file: string): string => join('..', CURRENT_LINK, BIN_DIR, file);

/** What the top-level files of a converted prefix link to, in the order they are switched: the bundle last. */
export const SUMS_LINK: Readonly<[string, string]> = [
  RELEASE_SUMS_FILE,
  join(CURRENT_LINK, RELEASE_SUMS_FILE),
];
export const NODE_LINK: Readonly<[string, string]> = [NODE_FILE, join(CURRENT_LINK, NODE_FILE)];
export const BUNDLE_LINK: Readonly<[string, string]> = [BUNDLE_FILE, join(CURRENT_LINK, BUNDLE_FILE)];

/**
 * The prefix of a running bundle. Node runs the main module from its real path, so in a converted prefix the bundle's
 * own directory is `<prefix>/releases/<version>`; this maps it back to `<prefix>`.
 */
export function installRootOf(bundleDir: string): string {
  const releases = dirname(bundleDir);
  if (basename(releases) !== RELEASES_DIR || runnerReleaseChannelOf(basename(bundleDir)) === null) {
    return bundleDir;
  }
  const root = dirname(releases);
  try {
    return lstatSync(join(root, CURRENT_LINK)).isSymbolicLink() ? root : bundleDir;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return bundleDir;
    }
    throw error;
  }
}
