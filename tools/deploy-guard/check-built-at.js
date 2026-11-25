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
// Fails closed: a missing file, a missing or non-string define, a value that is not a JSON string literal, a
// stamp not in the stamp step's exact shape, or one that this run cannot have written (too old, or in the
// future) all fail. No npm dependency, same as the other deploy guards.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFINE_KEY = '__TC_BUILT_AT__';
// The stamp step writes `date -u +%Y-%m-%dT%H:%M:%SZ`, then ` (<short sha>)`; the commit suffix is optional so a
// bare UTC timestamp still passes.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z( \([0-9a-f]{7,40}\))?$/;

// #973: the stamp step runs seconds before the config check and the deploy job is capped at 20 minutes, so an
// older stamp was not written by this run (a stamped define committed by mistake, a restored cache). An hour
// leaves room for a slow build; the future tolerance only covers a clock step between the two steps.
const MAX_STAMP_AGE_MS = 60 * 60 * 1000;
const MAX_STAMP_FUTURE_MS = 5 * 60 * 1000;

/**
 * Returns `stamp`'s instant in epoch milliseconds. Throws unless it is a real UTC timestamp in the stamp step's
 * shape (so not "local", empty or garbage).
 */
function assertValidStamp(stamp) {
  if (typeof stamp !== 'string') {
    throw new Error(`${DEFINE_KEY} is missing or not a string`);
  }
  if (stamp === 'local') {
    throw new Error(
      `${DEFINE_KEY} is still the "local" default — the stamp step did not run or did not apply`,
    );
  }
  const match = STAMP.exec(stamp);
  if (match === null) {
    throw new Error(
      `${DEFINE_KEY} ${JSON.stringify(stamp)} is not a UTC timestamp like 2026-01-31T12:00:00Z (abc1234)`,
    );
  }
  // The regex admits 2026-02-31T25:61:61Z; a round trip through Date rejects anything that is not a real instant.
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const parsed = new Date(`${iso}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== iso) {
    throw new Error(`${DEFINE_KEY} ${JSON.stringify(stamp)} is not a valid date and time`);
  }
  return parsed.getTime();
}

/** Throws unless `stamp` is valid and was taken within the last hour of `nowMs`. */
function assertFreshStamp(stamp, nowMs) {
  const ageMs = nowMs - assertValidStamp(stamp);
  // #983: NaN compares false both ways below, so a clock that is not a number would read as a fresh stamp.
  if (!Number.isFinite(ageMs)) {
    throw new Error(`cannot tell how old ${DEFINE_KEY} is: the current time is not a finite number`);
  }
  if (ageMs > MAX_STAMP_AGE_MS) {
    throw new Error(
      `${DEFINE_KEY} ${JSON.stringify(stamp)} is ${Math.floor(ageMs / 60000)} minutes old — this run's stamp step did not write it`,
    );
  }
  if (ageMs < -MAX_STAMP_FUTURE_MS) {
    throw new Error(`${DEFINE_KEY} ${JSON.stringify(stamp)} is in the future`);
  }
}

/**
 * Makes `text` safe as the message of a `::error::` workflow command (#973, SECURITY note on PR #962). The
 * runner reads one command per line and decodes `%0A`/`%0D`/`%25` in the message, so a raw line break would
 * end the annotation and let the rest of the text start a command of its own (`::add-mask::`,
 * `::stop-commands::`), and a literal `%0A` would be decoded into one. Line breaks and every other control
 * character become one space; `%` is escaped the way @actions/core does it.
 */
function toAnnotationText(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/%/g, '%25');
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
    throw new Error(
      `project.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
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
  } catch (error) {
    throw new Error(`${DEFINE_KEY} define ${JSON.stringify(expression)} is not a JSON string literal`, {
      cause: error,
    });
  }
  assertValidStamp(stamp);
  return stamp;
}

function listScripts(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .flatMap((entry) =>
      entry.isFile() && entry.name.endsWith('.js') ? [path.join(entry.parentPath, entry.name)] : [],
    );
}

/**
 * Throws unless some script in `browserDirectory` carries `stamp` as a string literal. The minifier picks the quote
 * (the production build emits a template literal); a validated stamp holds no quote, backslash or `${`, so each
 * quoted form is its literal source text.
 */
function assertStampInBundle(stamp, browserDirectory) {
  const scripts = listScripts(browserDirectory);
  if (scripts.length === 0) {
    throw new Error(`no .js files under ${browserDirectory} — is this the console build output?`);
  }
  const literals = ['"', "'", '`'].map((quote) => `${quote}${stamp}${quote}`);
  const isInlined = scripts.some((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return literals.some((literal) => source.includes(literal));
  });
  if (!isInlined) {
    throw new Error(`${JSON.stringify(stamp)} is not compiled into any script under ${browserDirectory}`);
  }
}

module.exports = { assertValidStamp, assertFreshStamp, readStamp, assertStampInBundle, toAnnotationText };

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
    assertFreshStamp(stamp, Date.now());
    if (isBundle) {
      assertStampInBundle(stamp, browserDirectory);
    }
    process.stdout.write(`::notice::console build stamp ${stamp} (${mode} check passed)\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `::error::console build stamp check (${mode}) failed: ${toAnnotationText(reason)}. See #960.\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
