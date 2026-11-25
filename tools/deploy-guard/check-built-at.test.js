#!/usr/bin/env node
// Fixtures for deploy.yml's console build-stamp checks (#960). Plain Node `assert`, run by security.yml's
// `workflow-lint` job next to the other tools/deploy-guard tests.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertValidStamp,
  assertFreshStamp,
  readStamp,
  assertStampInBundle,
  toAnnotationText,
} = require('./check-built-at');

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
  assert.throws(
    () => assertValidStamp(garbage),
    /not a UTC timestamp/,
    `must reject ${JSON.stringify(garbage)}`,
  );
}
for (const impossible of [
  '2026-02-30T00:00:00Z',
  '2027-02-29T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '2026-11-24T24:00:00Z',
  '2026-11-24T09:60:00Z',
]) {
  assert.throws(() => assertValidStamp(impossible), /not a valid date and time/, `must reject ${impossible}`);
}

// --- assertFreshStamp (#973): only a stamp this run can have written passes. ---
const STAMP_MS = Date.UTC(2026, 10, 24, 9, 41, 7);
const MINUTE_MS = 60 * 1000;
assert.strictEqual(assertValidStamp(STAMP), STAMP_MS);
assertFreshStamp(STAMP, STAMP_MS);
assertFreshStamp(STAMP, STAMP_MS + 60 * MINUTE_MS);
assertFreshStamp(STAMP, STAMP_MS - 5 * MINUTE_MS);
assert.throws(() => assertFreshStamp(STAMP, STAMP_MS + 60 * MINUTE_MS + 1), /is 60 minutes old/);
assert.throws(() => assertFreshStamp(STAMP, STAMP_MS + 400 * 24 * 60 * MINUTE_MS), /minutes old/);
assert.throws(() => assertFreshStamp(STAMP, STAMP_MS - 5 * MINUTE_MS - 1), /is in the future/);
assert.throws(() => assertFreshStamp('local', STAMP_MS), /"local" default/);
// #983: without a usable clock the age is NaN, which is neither too old nor in the future — it must not pass.
for (const noClock of [NaN, undefined, Infinity, -Infinity, 'now', {}]) {
  assert.throws(() => assertFreshStamp(STAMP, noClock), /current time is not a finite number/);
}
assert.throws(() => assertFreshStamp('garbage', NaN), /not a UTC timestamp/);

// --- toAnnotationText (#973): nothing in a failure reason can end the annotation or start a command. ---
assert.strictEqual(toAnnotationText('plain reason'), 'plain reason');
assert.strictEqual(toAnnotationText('a\nb'), 'a b');
assert.strictEqual(toAnnotationText('a\r\n::add-mask::y'), 'a ::add-mask::y');
assert.strictEqual(toAnnotationText('a\u2028b\u2029c\u0085d\u0000e\u001bf\u007fg\th'), 'a b c d e f g h');
assert.strictEqual(toAnnotationText('100%0A::error::x %0D %25'), '100%250A::error::x %250D %2525');
assert.strictEqual(toAnnotationText(undefined), 'undefined');
for (const hostile of ['\n::add-mask::x', '\r::stop-commands::t', 'x%0A::warning::y', '\u2028::debug::z']) {
  const text = toAnnotationText(hostile);
  assert.doesNotMatch(text, /[\r\n\u2028\u2029]/, `no line break may survive in ${JSON.stringify(hostile)}`);
  assert.doesNotMatch(text, /%(?!25)/, `no decodable escape may survive in ${JSON.stringify(hostile)}`);
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

  // The stamp only inside a longer string or a comment is not the inlined define.
  fs.writeFileSync(
    path.join(browser, 'main-ABC.js'),
    `const b={builtAt:"local"};/* ${STAMP} */const c="x${STAMP}";`,
  );
  assert.throws(() => assertStampInBundle(STAMP, browser), /not compiled into any script/);

  // Whatever quote the minifier picks (the production build emits a template literal).
  for (const quote of ['`', '"', "'"]) {
    fs.writeFileSync(
      path.join(browser, 'chunks', 'chunk-DEF.js'),
      `const b={version:"0.1.0",builtAt:${quote}${STAMP}${quote}};`,
    );
    assertStampInBundle(STAMP, browser);
  }
  assert.throws(() => assertStampInBundle('2026-11-24T09:41:08Z (686b1da)', browser), /not compiled/);
  assert.throws(() => assertStampInBundle(STAMP, path.join(tmp, 'missing')), /ENOENT/);

  // --- CLI: exit codes the workflow relies on. ---
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  // The CLI compares against the real clock, so its fixtures are stamped the way the stamp step does it.
  const stampAt = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z (686b1da)`;
  const writeProject = (name, stamp) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, projectWith({ __TC_BUILT_AT__: JSON.stringify(stamp) }));
    return file;
  };
  const freshStamp = stampAt(Date.now());
  const stamped = writeProject('project.json', freshStamp);
  fs.writeFileSync(path.join(browser, 'chunks', 'chunk-NOW.js'), `const b={builtAt:\`${freshStamp}\`};`);

  assert.strictEqual(run('config', stamped).status, 0);
  assert.strictEqual(run('bundle', stamped, browser).status, 0);

  // #973: a well-formed stamp this run cannot have written fails both modes, even when the bundle carries it.
  const stale = run('config', writeProject('stale.json', STAMP));
  assert.strictEqual(stale.status, 1);
  assert.match(stale.stderr, /^::error::.*minutes old/);
  assert.strictEqual(run('bundle', writeProject('stale.json', STAMP), browser).status, 1);
  const twoHoursOld = run('config', writeProject('old.json', stampAt(Date.now() - 2 * 60 * MINUTE_MS)));
  assert.strictEqual(twoHoursOld.status, 1);
  const future = run('config', writeProject('future.json', stampAt(Date.now() + 60 * MINUTE_MS)));
  assert.strictEqual(future.status, 1);
  assert.match(future.stderr, /^::error::.*in the future/);

  // #973: a hostile project.json or path cannot break the annotation or inject a workflow command: the whole
  // of stderr is one `::error::` line, whatever the reason carried.
  const assertOneErrorLine = (result, label) => {
    assert.strictEqual(result.status, 1, label);
    assert.match(
      result.stderr,
      /^::error::console build stamp check \((config|bundle)\) failed: [^\r\n]*\n$/,
      label,
    );
    assert.doesNotMatch(result.stderr, /%(?!25)/, label);
  };
  const multiline = path.join(tmp, 'multiline.json');
  // V8 quotes the offending source in its message: this is the raw line break the PR #962 review reproduced.
  fs.writeFileSync(multiline, '[1,\r\n::warning::injected\n::add-mask::y%0A]\n');
  assert.throws(() => readStamp(fs.readFileSync(multiline, 'utf8')), /not valid JSON[^]*\n::warning:/);
  assertOneErrorLine(run('config', multiline), 'malformed multi-line project.json');
  const hostileDefine = path.join(tmp, 'hostile.json');
  fs.writeFileSync(
    hostileDefine,
    projectWith({ __TC_BUILT_AT__: '"x\\n::error::injected%0A::stop-commands::t"' }),
  );
  assertOneErrorLine(run('config', hostileDefine), 'define with an escaped line break');
  assertOneErrorLine(
    run('config', path.join(tmp, 'no\n::warning::such%0A.json')),
    'hostile project.json path',
  );
  assertOneErrorLine(
    run('bundle', stamped, path.join(tmp, 'no\n::warning::such')),
    'hostile bundle directory',
  );
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

process.stdout.write(
  'ok: check-built-at rejects a missing, "local", malformed or stale stamp and one absent from the bundle, on one ::error:: line\n',
);
