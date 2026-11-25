#!/usr/bin/env node
// ci.yml's scope decisions ("Select projects", "Does this change reach the Darwin sweep?"): does any path
// changed between two commits match a pattern? Prints exactly `true` or `false`.
//
//   node tools/ci/changed-paths.mjs <base sha> <head sha> <pattern>
//   node tools/ci/changed-paths.mjs --event-scope <pattern>
//
// The second form is the whole decision of the `runner-darwin-scope` and `runtime-image-scope` jobs (#1005: the
// two steps repeated it in bash): it works out what to compare from the event, read from EVENT, BASE_REF and
// BEFORE in the environment and from the checked-out HEAD, and answers `true` without comparing on a release PR
// or when a push has no usable base. One line on stderr says which case it was, in constant words.
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

import { execFileSync, spawnSync } from 'node:child_process';
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

/** The full sha of a commit named by a revision this script wrote itself (never by an argument). */
function commitOf(revision, cwd) {
  const sha = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  if (!FULL_SHA.test(sha)) throw new Error('git rev-parse did not print a commit sha');
  return sha;
}

/** Whether the repository has that commit. Only ever asked about a full sha. */
function hasCommit(sha, cwd) {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' }).status === 0;
}

/**
 * Whether the event at hand can have changed a path matching `pattern`, and which case decided it:
 *  - a pull request into anything but `dev` is a release PR: always in scope;
 *  - a pull request into `dev` compares the merge commit GitHub checked out with its first parent, the base
 *    branch's tip;
 *  - any other event (a push) compares `before` with HEAD when `before` is a commit this clone has;
 *  - otherwise (a first push, a forced one, a shallow clone) there is no base to compare with: in scope.
 * Every failure throws, a pattern that is not a regular expression included, whichever case applies: the
 * caller must stop rather than fall back to "nothing changed".
 * @param {{ event: string | undefined, baseRef: string | undefined, before: string | undefined,
 *   pattern: string, cwd?: string }} input
 * @returns {{ run: boolean, why: string }} `why` is constant text, safe to print
 */
export function scopeOfEvent({ event, baseRef, before, pattern, cwd = process.cwd() }) {
  if (typeof event !== 'string' || event === '') throw new ArgumentError('EVENT', 'is not set');
  if (typeof baseRef !== 'string' || baseRef === '') throw new ArgumentError('BASE_REF', 'is not set');
  anyPathMatches([], pattern);
  const head = commitOf('HEAD', cwd);
  if (event === 'pull_request') {
    if (baseRef !== 'dev') return { run: true, why: 'a release PR, into a branch other than dev' };
    const base = commitOf('HEAD^1', cwd);
    return {
      run: anyPathMatches(listChangedPaths(base, head, cwd), pattern),
      why: 'compared the pull request merge commit with its first parent',
    };
  }
  if (typeof before === 'string' && FULL_SHA.test(before) && hasCommit(before, cwd)) {
    return {
      run: anyPathMatches(listChangedPaths(before, head, cwd), pattern),
      why: 'compared HEAD with the commit before the push',
    };
  }
  return { run: true, why: 'no base to compare with' };
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

/** Turns a failure into the one constant annotation line; see `main`. */
function reportFailure(error, otherwise) {
  // Only constant text: an ArgumentError names the argument by its role, and any other reason can quote a
  // sha, a pattern or git's output, none of which belongs in a workflow command. git's own stderr is
  // already in the log above this line.
  const reason = error instanceof ArgumentError ? error.message : otherwise;
  process.stderr.write(`::error::changed-paths: ${reason}. See #973.\n`);
}

function mainEventScope(argv) {
  const [pattern, ...rest] = argv;
  const usageProblem =
    pattern === undefined
      ? '<pattern> is missing'
      : pattern === ''
        ? '<pattern> is empty'
        : rest.length > 0
          ? `${rest.length} unexpected extra argument(s) after <pattern>`
          : null;
  if (usageProblem !== null) {
    process.stderr.write(
      `changed-paths: ${usageProblem}\nusage: changed-paths.mjs --event-scope <pattern>\n`,
    );
    return 2;
  }
  let scope;
  try {
    const { EVENT: event, BASE_REF: baseRef, BEFORE: before } = process.env;
    scope = scopeOfEvent({ event, baseRef, before, pattern });
  } catch (error) {
    reportFailure(error, 'git could not tell what this event changed');
    return 1;
  }
  process.stderr.write(`changed-paths: ${scope.run} (${scope.why})\n`);
  process.stdout.write(`${scope.run}\n`);
  return 0;
}

function main(argv) {
  if (argv[0] === '--event-scope') return mainEventScope(argv.slice(1));
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
    reportFailure(error, 'git could not list the paths changed between <base sha> and <head sha>');
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
