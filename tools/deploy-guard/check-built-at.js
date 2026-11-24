#!/usr/bin/env node
// deploy.yml's console build-stamp checks (#960, follow-up to #941/#951). The «Обновлено» note compares
// `${version}@${builtAt}`; `builtAt` is `__TC_BUILT_AT__`, which only deploy.yml's stamp step sets. A deploy
// without the stamp ships the "local" default, every build then looks the same and the note goes silent with
// nobody noticing. So the deploy fails instead:
//
//   node check-built-at.js config <apps/console/project.json>
//       after the stamp step: the production `define` holds a real UTC stamp, not "local" or garbage.
//   node check-built-at.js bundle <apps/console/project.json> <dist/apps/console/browser>
//       after the build, before anything ships: that exact stamp is compiled into the bundle the api Worker
//       serves (catches a build that ignored or overrode the define, or a stale cached output).
//
// Fails closed: a missing file, a missing or non-string define, a value that is not a JSON string literal, or a
// stamp not in the stamp step's exact shape all fail. No npm dependency, same as the other deploy guards.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFINE_KEY = '__TC_BUILT_AT__';
// The stamp step writes `date -u +%Y-%m-%dT%H:%M:%SZ`, then ` (<short sha>)`; the commit suffix is optional so a
// bare UTC timestamp still passes.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z( \([0-9a-f]{7,40}\))?$/;

/** Throws unless `stamp` is a real UTC timestamp in the stamp step's shape (so not "local", empty or garbage). */
function assertValidStamp(stamp) {
  if (typeof stamp !== 'string') {
    throw new Error(`${DEFINE_KEY} is missing or not a string`);
  }
  if (stamp === 'local') {
    throw new Error(`${DEFINE_KEY} is still the "local" default — the stamp step did not run or did not apply`);
  }
  const match = STAMP.exec(stamp);
  if (match === null) {
    throw new Error(`${DEFINE_KEY} ${JSON.stringify(stamp)} is not a UTC timestamp like 2026-01-31T12:00:00Z (abc1234)`);
  }
  // The regex admits 2026-02-31T25:61:61Z; a round trip through Date rejects anything that is not a real instant.
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const parsed = new Date(`${iso}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== iso) {
    throw new Error(`${DEFINE_KEY} ${JSON.stringify(stamp)} is not a valid date and time`);
  }
}

/**
 * Returns the stamp the production build will inline, read from the console's project.json source. The define
 * value is a JS expression, so a stamped one is a JSON string literal (`"\"2026-…Z (abc1234)\""`).
 */
function readStamp(projectJsonSource) {
  let project;
  try {
    project = JSON.parse(projectJsonSource);
  } catch (error) {
    throw new Error(`project.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const define = project?.targets?.build?.configurations?.production?.define;
  if (typeof define !== 'object' || define === null || !Object.hasOwn(define, DEFINE_KEY)) {
    throw new Error(`targets.build.configurations.production.define.${DEFINE_KEY} is missing`);
  }
  const expression = define[DEFINE_KEY];
  if (typeof expression !== 'string') {
    throw new Error(`${DEFINE_KEY} define is not a string`);
  }
  let stamp;
  try {
    stamp = JSON.parse(expression);
  } catch {
    throw new Error(`${DEFINE_KEY} define ${JSON.stringify(expression)} is not a JSON string literal`);
  }
  assertValidStamp(stamp);
  return stamp;
}

function listScripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true, recursive: true }).flatMap((entry) =>
    entry.isFile() && entry.name.endsWith('.js') ? [path.join(entry.parentPath, entry.name)] : [],
  );
}

/** Throws unless some script in `browserDirectory` carries `stamp` (already validated, so it holds no quotes). */
function assertStampInBundle(stamp, browserDirectory) {
  const scripts = listScripts(browserDirectory);
  if (scripts.length === 0) {
    throw new Error(`no .js files under ${browserDirectory} — is this the console build output?`);
  }
  const isInlined = scripts.some((file) => fs.readFileSync(file, 'utf8').includes(`"${stamp}"`));
  if (!isInlined) {
    throw new Error(`${JSON.stringify(stamp)} is not compiled into any script under ${browserDirectory}`);
  }
}

module.exports = { assertValidStamp, readStamp, assertStampInBundle };

function main(argv) {
  const [mode, projectJsonPath, browserDirectory] = argv;
  const isConfig = mode === 'config' && projectJsonPath !== undefined && browserDirectory === undefined;
  const isBundle = mode === 'bundle' && projectJsonPath !== undefined && browserDirectory !== undefined;
  if (!isConfig && !isBundle) {
    process.stderr.write(
      'usage: check-built-at.js config <project.json>\n       check-built-at.js bundle <project.json> <browserDir>\n',
    );
    return 2;
  }
  try {
    const stamp = readStamp(fs.readFileSync(projectJsonPath, 'utf8'));
    if (isBundle) {
      assertStampInBundle(stamp, browserDirectory);
    }
    process.stdout.write(`::notice::console build stamp ${stamp} (${mode} check passed)\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::console build stamp check (${mode}) failed: ${reason}. See #960.\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
