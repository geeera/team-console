#!/usr/bin/env node
// Fixtures for deploy.yml's runner-release check (S1 of the #634 security note). Not a Vitest spec: the guard runs
// before `npm ci`, so this runs with Node's builtin `assert` from security.yml's `workflow-lint` job. `gh` is a fake
// that writes a planted SHA256SUMS or fails; nothing touches the network.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  attestationArgs,
  downloadArgs,
  imageSubjectOf,
  namedRelease,
  releaseVarsOf,
  verifyAgainstRelease,
  verifyImage,
} = require('./check-runner-release');

const DIGEST = `sha256:${'9'.repeat(64)}`;

const VERSION = '0.2.0';
const SUMS = [
  `${'a'.repeat(64)}  team-console-runner-0.2.0-darwin-arm64.tar.gz`,
  `${'b'.repeat(64)}  team-console-runner-0.2.0-darwin-x64.tar.gz`,
  `${'c'.repeat(64)}  team-console-runner-0.2.0-linux-arm64.tar.gz`,
  `${'d'.repeat(64)}  team-console-runner-0.2.0-linux-x64.tar.gz`,
  '',
].join('\n');

const config = (vars) => `// comment\n{ "env": { "dev": { "vars": ${JSON.stringify(vars)}, }, }, }`;

let failures = 0;
function test(name, body) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}\n  ${error instanceof Error ? error.stack : String(error)}`);
  }
}

test('reads the three vars from the env block, and refuses a config without them', () => {
  const vars = releaseVarsOf(
    config({
      RUNNER_RELEASE_VERSION: VERSION,
      RUNNER_RELEASE_SHA256SUMS: SUMS,
      RUNNER_RELEASE_IMAGE_DIGEST: DIGEST,
    }),
    'dev',
  );
  assert.deepStrictEqual(vars, { version: VERSION, sums: SUMS, imageDigest: DIGEST });
  const missing =
    /must set RUNNER_RELEASE_VERSION, RUNNER_RELEASE_SHA256SUMS and RUNNER_RELEASE_IMAGE_DIGEST/;
  assert.throws(() => releaseVarsOf(config({ RUNNER_RELEASE_VERSION: '' }), 'dev'), missing);
  assert.throws(
    () => releaseVarsOf(config({ RUNNER_RELEASE_VERSION: '', RUNNER_RELEASE_SHA256SUMS: '' }), 'dev'),
    missing,
  );
  assert.throws(() => releaseVarsOf(config({}), 'stage'), /'env\.stage\.vars' is missing/);
});

test('takes an image digest only as sha256:<64 hex> and only with a named release (#634 PR 7)', () => {
  assert.strictEqual(namedRelease({ version: VERSION, sums: SUMS, imageDigest: DIGEST }), VERSION);
  assert.strictEqual(namedRelease({ version: VERSION, sums: SUMS, imageDigest: '' }), VERSION);
  assert.throws(
    () => namedRelease({ version: '', sums: '', imageDigest: DIGEST }),
    /RUNNER_RELEASE_VERSION is empty/,
  );
  for (const imageDigest of [
    '9'.repeat(64),
    `sha256:${'9'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`,
    `${DIGEST} `,
    `${DIGEST};id`,
    'ghcr.io/geeera/team-console-runner:0.2.0',
    `sha512:${'9'.repeat(128)}`,
  ]) {
    assert.throws(
      () => namedRelease({ version: VERSION, sums: SUMS, imageDigest }),
      /must be sha256:<64 lower-case hex>/,
      imageDigest,
    );
  }
});

test('verifies the image digest’s attestation by digest with the pinned identity', () => {
  const { gh, calls } = fakeGh(SUMS);
  verifyImage(VERSION, DIGEST, gh);
  assert.deepStrictEqual(calls, [
    ['gh', ...attestationArgs(`oci://ghcr.io/geeera/team-console-runner@${DIGEST}`, VERSION)],
  ]);
  assert.strictEqual(imageSubjectOf(DIGEST), `oci://ghcr.io/geeera/team-console-runner@${DIGEST}`);
  assert.ok(calls[0].includes('refs/tags/v0.2.0'));
  assert.ok(calls[0].includes('--deny-self-hosted-runners'));
  assert.throws(
    () => verifyImage(VERSION, DIGEST, fakeGh(SUMS, 'attestation').gh),
    /gh attestation exited 1/,
  );
});

test('names no release when both are empty', () => {
  assert.strictEqual(namedRelease({ version: '', sums: '' }), null);
});

test('refuses one var without the other', () => {
  assert.throws(() => namedRelease({ version: VERSION, sums: '' }), /RUNNER_RELEASE_SHA256SUMS is empty/);
  assert.throws(() => namedRelease({ version: '', sums: SUMS }), /RUNNER_RELEASE_VERSION is empty/);
});

test('refuses a version that is not a release version', () => {
  for (const version of ['v0.2.0', '0.2', '0.2.0+build', '0.2.0; rm -rf /', '01.2.0']) {
    assert.throws(() => namedRelease({ version, sums: SUMS }), /not a release version/, version);
  }
});

test('refuses sums of another shape: missing newline, a line too many or too few, another version, another name', () => {
  const lines = SUMS.split('\n');
  for (const sums of [
    SUMS.slice(0, -1),
    `${SUMS}${'e'.repeat(64)}  extra.tar.gz\n`,
    `${lines.slice(1).join('\n')}`,
    SUMS.replaceAll('0.2.0', '0.1.0'),
    SUMS.replace('darwin-x64', 'darwin-x65'),
    SUMS.replace(' '.repeat(2), ' '),
    SUMS.replace('a'.repeat(64), 'A'.repeat(64)),
    [lines[1], lines[0], ...lines.slice(2)].join('\n'),
  ]) {
    assert.throws(() => namedRelease({ version: VERSION, sums }), /must be the release's SHA256SUMS text/);
  }
  assert.strictEqual(namedRelease({ version: VERSION, sums: SUMS }), VERSION);
});

function fakeGh(published, failOn) {
  const calls = [];
  const gh = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === failOn) {
      throw new Error(`gh ${failOn} exited 1`);
    }
    if (args[0] === 'release') {
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'SHA256SUMS'), published);
    }
  };
  return { gh, calls };
}

test('downloads SHA256SUMS of the named tag, verifies its attestation with the pinned identity, and accepts an equal var', () => {
  const { gh, calls } = fakeGh(SUMS);
  verifyAgainstRelease(VERSION, SUMS, gh);
  assert.deepStrictEqual(calls.length, 2);
  const dir = calls[0][calls[0].indexOf('--dir') + 1];
  assert.deepStrictEqual(calls[0], ['gh', ...downloadArgs(VERSION, dir)]);
  assert.deepStrictEqual(calls[1], ['gh', ...attestationArgs(path.join(dir, 'SHA256SUMS'), VERSION)]);
  assert.ok(calls[1].includes('refs/tags/v0.2.0'));
  assert.ok(!fs.existsSync(dir), 'the download directory is removed');
});

test('refuses a var that differs from the attested file by one byte', () => {
  const { gh } = fakeGh(SUMS.replace('a', 'f'));
  assert.throws(
    () => verifyAgainstRelease(VERSION, SUMS, gh),
    /differs from the attested SHA256SUMS of v0\.2\.0/,
  );
});

test('refuses when the download or the attestation check fails', () => {
  assert.throws(() => verifyAgainstRelease(VERSION, SUMS, fakeGh(SUMS, 'release').gh), /gh release exited 1/);
  assert.throws(
    () => verifyAgainstRelease(VERSION, SUMS, fakeGh(SUMS, 'attestation').gh),
    /gh attestation exited 1/,
  );
});

test('the committed wrangler.jsonc is well formed for every environment', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../apps/api/wrangler.jsonc'), 'utf8');
  for (const env of ['dev', 'stage', 'production']) {
    namedRelease(releaseVarsOf(source, env));
  }
});

if (failures > 0) {
  console.error(`${String(failures)} failed`);
  process.exit(1);
}
