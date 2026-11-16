import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runnerReleaseChannelOf } from '@shared/contracts';
import { BUNDLE_FILE, RELEASE_SUMS_FILE } from './release-identity';

/**
 * The install directory `update` maintains (#604): each release in its own `releases/<version>/`, one `current`
 * symlink naming the live one, and `team-console-runner.mjs`, `bin` and `SHA256SUMS` as fixed symlinks through it. Switching
 * releases is then one `rename` of `current`, so a crash leaves either the old release or the new one, never a mix.
 * The service and the sudoers rule keep naming `<prefix>/team-console-runner.mjs` and `<prefix>/bin/job-exec`.
 * A tarball extracted by hand (the documented first install) is flat; the first `update` converts it.
 */

export const RELEASES_DIR = 'releases';
export const CURRENT_LINK = 'current';

/** `releases/<version>`, relative so the prefix stays movable. */
export const releaseDirOf = (version: string): string => join(RELEASES_DIR, version);

/** What each top-level entry of a converted prefix links to; the bundle last. */
export const TOP_LEVEL_LINKS: Readonly<Record<string, string>> = {
  [RELEASE_SUMS_FILE]: join(CURRENT_LINK, RELEASE_SUMS_FILE),
  bin: join(CURRENT_LINK, 'bin'),
  [BUNDLE_FILE]: join(CURRENT_LINK, BUNDLE_FILE),
};

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
