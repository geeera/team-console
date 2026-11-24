#!/usr/bin/env node
// ci.yml's scope decisions ("Select projects", "Does this change reach the Darwin sweep?"): does any path
// changed between two commits match a pattern? Prints exactly `true` or `false`.
//
//   node tools/ci/changed-paths.mjs <base sha> <head sha> <pattern>
//
// It replaces `git diff --name-only | grep -E` (#973, SECURITY note on PR #963). That listing is line-based and
// git C-quotes a path holding a quote, a backslash or a control character (`"apps/runner/a\"b.ts"`), so such a
// path missed a `^`-anchored pattern and the change slipped past the scope; a line break in a file name also
// split one path into two "paths". Here git prints the paths NUL-separated and verbatim (`-z`), each is matched
// whole, and a rename counts as a deletion plus an addition (`--no-renames`), so the old path is seen too.
//
// Fails closed: anything but two full commit shas, an unreadable pattern or a failing git exits non-zero with
// nothing on stdout, so the caller's `$(…)` under `set -e` stops the job instead of picking the cheap scope.
// No npm dependency: the scope job runs it straight after checkout, without `npm ci`.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;
// A real diff is a few kB; this only keeps a very large one from failing on Node's 1 MB default.
const MAX_LISTING_BYTES = 256 * 1024 * 1024;

/** The paths of a `git diff -z --name-only` listing. latin1 keeps one char per byte, so no path is altered. */
export function splitPaths(listing) {
  return listing
    .toString('latin1')
    .split('\0')
    .filter((entry) => entry !== '');
}

/** True when some path matches. No `m` flag: `^` and `$` mean the whole path, even one holding a line break. */
export function anyPathMatches(paths, pattern) {
  const matcher = new RegExp(pattern);
  return paths.some((entry) => matcher.test(entry));
}

/** Every path that differs between the two commits; a rename is listed as its old and its new path. */
export function listChangedPaths(base, head, cwd = process.cwd()) {
  // The shas go to git as revisions, so anything else (a ref name, an `--option`) is refused before it gets there.
  if (!FULL_SHA.test(base) || !FULL_SHA.test(head)) {
    throw new Error('base and head must be full 40-character commit shas');
  }
  const listing = execFileSync('git', ['diff', '-z', '--no-renames', '--name-only', base, head, '--'], {
    cwd,
    maxBuffer: MAX_LISTING_BYTES,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return splitPaths(listing);
}

function main(argv) {
  const [base, head, pattern, ...rest] = argv;
  if (
    base === undefined ||
    head === undefined ||
    pattern === undefined ||
    pattern === '' ||
    rest.length > 0
  ) {
    process.stderr.write('usage: changed-paths.mjs <base sha> <head sha> <pattern>\n');
    return 2;
  }
  let isMatch;
  try {
    isMatch = anyPathMatches(listChangedPaths(base, head), pattern);
  } catch {
    // A constant message: the reason can quote a sha, a pattern or git's output, none of which belongs in a
    // workflow command. git's own stderr is already in the log above this line.
    process.stderr.write('::error::changed-paths could not list or match the changed paths. See #973.\n');
    return 1;
  }
  process.stdout.write(`${isMatch}\n`);
  return 0;
}

/** Same check as audit-gate.mjs: true only when Node was asked to run this file, however its path is spelled. */
function isRunAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  process.exit(main(process.argv.slice(2)));
}
