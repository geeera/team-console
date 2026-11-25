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
// The match ignores case (#983): the macOS sweep checks out onto a case-insensitive volume, where
// `Apps/Runner/x.ts` lands in `apps/runner/`. Matching too much only widens a scope, never narrows one.
//
// Fails closed: anything but two full commit shas, an unreadable pattern or a failing git exits non-zero with
// nothing on stdout, so the caller's `$(…)` under `set -e` stops the job instead of picking the cheap scope.
// The failure line names the argument at fault by its role (`<base sha>`), never by its value (#983).
// No npm dependency: the scope job runs it straight after checkout, without `npm ci`.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;
// A real diff is a few kB; this only keeps a very large one from failing on Node's 1 MB default.
const MAX_LISTING_BYTES = 256 * 1024 * 1024;

/**
 * An argument this script cannot use. `argument` is one of the usage line's own names and `problem` a constant
 * text, so the message is safe inside a workflow command whatever the argument held.
 */
export class ArgumentError extends Error {
  constructor(argument, problem, options) {
    super(`<${argument}> ${problem}`, options);
    this.name = 'ArgumentError';
    this.argument = argument;
  }
}

/** The paths of a `git diff -z --name-only` listing. latin1 keeps one char per byte, so no path is altered. */
export function splitPaths(listing) {
  return listing
    .toString('latin1')
    .split('\0')
    .filter((entry) => entry !== '');
}

/**
 * True when some path matches, whatever its case. No `m` flag: `^` and `$` mean the whole path, even one
 * holding a line break.
 */
export function anyPathMatches(paths, pattern) {
  let matcher;
  try {
    matcher = new RegExp(pattern, 'i');
  } catch (error) {
    throw new ArgumentError('pattern', 'is not a regular expression', { cause: error });
  }
  return paths.some((entry) => matcher.test(entry));
}

/** Every path that differs between the two commits; a rename is listed as its old and its new path. */
export function listChangedPaths(base, head, cwd = process.cwd()) {
  // The shas go to git as revisions, so anything else (a ref name, an `--option`) is refused before it gets there.
  for (const [argument, sha] of [
    ['base sha', base],
    ['head sha', head],
  ]) {
    if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
      throw new ArgumentError(argument, 'is not a full 40-character commit sha');
    }
  }
  const listing = execFileSync('git', ['diff', '-z', '--no-renames', '--name-only', base, head, '--'], {
    cwd,
    maxBuffer: MAX_LISTING_BYTES,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return splitPaths(listing);
}

/** What is wrong with the argument list, naming the argument, or `null` when all three are there. */
function usageProblemOf(base, head, pattern, rest) {
  if (base === undefined) return '<base sha> is missing';
  if (head === undefined) return '<head sha> is missing';
  if (pattern === undefined) return '<pattern> is missing';
  if (pattern === '') return '<pattern> is empty';
  if (rest.length > 0) return `${rest.length} unexpected extra argument(s) after <pattern>`;
  return null;
}

function main(argv) {
  const [base, head, pattern, ...rest] = argv;
  const usageProblem = usageProblemOf(base, head, pattern, rest);
  if (usageProblem !== null) {
    process.stderr.write(
      `changed-paths: ${usageProblem}\nusage: changed-paths.mjs <base sha> <head sha> <pattern>\n`,
    );
    return 2;
  }
  let isMatch;
  try {
    isMatch = anyPathMatches(listChangedPaths(base, head), pattern);
  } catch (error) {
    // Only constant text: an ArgumentError names the argument by its role, and any other reason can quote a
    // sha, a pattern or git's output, none of which belongs in a workflow command. git's own stderr is
    // already in the log above this line.
    const reason =
      error instanceof ArgumentError
        ? error.message
        : 'git could not list the paths changed between <base sha> and <head sha>';
    process.stderr.write(`::error::changed-paths: ${reason}. See #973.\n`);
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
