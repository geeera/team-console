#!/usr/bin/env node
// Fixtures for deploy.yml's console build-stamp checks (#960). Plain Node `assert`, run by security.yml's
// `workflow-lint` job next to the other tools/deploy-guard tests.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertValidStamp, readStamp, assertStampInBundle } = require('./check-built-at');

const SCRIPT = path.join(__dirname, 'check-built-at.js');
const REPO_PROJECT_JSON = path.join(__dirname, '..', '..', 'apps', 'console', 'project.json');
const STAMP = '2026-11-24T09:41:07Z (686b1da)';

function projectWith(define) {
  return JSON.stringify({ targets: { build: { configurations: { production: { define } } } } });
}

// --- assertValidStamp: only a real UTC stamp in the stamp step's shape passes. ---
assertValidStamp(STAMP);
assertValidStamp('2026-11-24T09:41:07Z');
assertValidStamp(`2026-11-24T09:41:07Z (${'a'.repeat(40)})`);
assertValidStamp('2028-02-29T23:59:59Z');

assert.throws(() => assertValidStamp(undefined), /missing or not a string/);
assert.throws(() => assertValidStamp(42), /missing or not a string/);
assert.throws(() => assertValidStamp('local'), /"local" default/);
for (const garbage of [
  '',
  ' ',
  'garbage',
  'local (686b1da)',
  '2026-11-24',
  '2026-11-24 09:41:07Z',
  '2026-11-24T09:41:07',
  '2026-11-24T09:41:07+03:00',
  '2026-11-24T09:41:07.123Z',
  '2026-11-24T09:41:07Z ()',
  '2026-11-24T09:41:07Z (XYZ1234)',
  '2026-11-24T09:41:07Z (686b1da) ',
  '2026-11-24T09:41:07Z (686b1da)\n',
  '2026-11-24T09:41:07Z (686b1da)"; alert(1); "',
]) {
  assert.throws(() => assertValidStamp(garbage), /not a UTC timestamp/, `must reject ${JSON.stringify(garbage)}`);
}
for (const impossible of ['2026-02-30T00:00:00Z', '2027-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-24T24:00:00Z', '2026-11-24T09:60:00Z']) {
  assert.throws(() => assertValidStamp(impossible), /not a valid date and time/, `must reject ${impossible}`);
}

// --- readStamp: the define is read from project.json and must be a stamped JSON string literal. ---
assert.strictEqual(readStamp(projectWith({ __TC_BUILT_AT__: JSON.stringify(STAMP) })), STAMP);
assert.throws(() => readStamp(projectWith({ __TC_BUILT_AT__: '"local"' })), /"local" default/);
assert.throws(() => readStamp(projectWith({})), /__TC_BUILT_AT__ is missing/);
assert.throws(() => readStamp(projectWith(undefined)), /__TC_BUILT_AT__ is missing/);
assert.throws(() => readStamp(JSON.stringify({ targets: {} })), /__TC_BUILT_AT__ is missing/);
assert.throws(() => readStamp(projectWith({ __TC_BUILT_AT__: 7 })), /define is not a string/);
assert.throws(() => readStamp(projectWith({ __TC_BUILT_AT__: STAMP })), /not a JSON string literal/);
assert.throws(() => readStamp(projectWith({ __TC_BUILT_AT__: '"garbage"' })), /not a UTC timestamp/);
assert.throws(() => readStamp('{ not json'), /not valid JSON/);

// --- assertStampInBundle: the stamp must be compiled into the served scripts. ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-built-at-'));
try {
  const browser = path.join(tmp, 'browser');
  fs.mkdirSync(path.join(browser, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(browser, 'index.html'), `<script>"${STAMP}"</script>`);
  assert.throws(() => assertStampInBundle(STAMP, browser), /no \.js files/);

  fs.writeFileSync(path.join(browser, 'main-ABC.js'), 'const b={version:"0.1.0",builtAt:"local"};');
  assert.throws(() => assertStampInBundle(STAMP, browser), /not compiled into any script/);

  fs.writeFileSync(path.join(browser, 'chunks', 'chunk-DEF.js'), `const b={version:"0.1.0",builtAt:"${STAMP}"};`);
  assertStampInBundle(STAMP, browser);
  assert.throws(() => assertStampInBundle('2026-11-24T09:41:08Z (686b1da)', browser), /not compiled/);
  assert.throws(() => assertStampInBundle(STAMP, path.join(tmp, 'missing')), /ENOENT/);

  // --- CLI: exit codes the workflow relies on. ---
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const stamped = path.join(tmp, 'project.json');
  fs.writeFileSync(stamped, projectWith({ __TC_BUILT_AT__: JSON.stringify(STAMP) }));

  assert.strictEqual(run('config', stamped).status, 0);
  assert.strictEqual(run('bundle', stamped, browser).status, 0);
  assert.strictEqual(run('config', path.join(tmp, 'nope.json')).status, 1);
  assert.strictEqual(run().status, 2);
  assert.strictEqual(run('config').status, 2);
  assert.strictEqual(run('config', stamped, browser).status, 2);
  assert.strictEqual(run('bundle', stamped).status, 2);
  assert.strictEqual(run('other', stamped).status, 2);

  // The committed project.json is the unstamped "local" default: deploying it as is must fail.
  const unstamped = run('config', REPO_PROJECT_JSON);
  assert.strictEqual(unstamped.status, 1);
  assert.match(unstamped.stderr, /::error::.*"local" default/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write('ok: check-built-at rejects a missing, "local" or malformed stamp and one absent from the bundle\n');
