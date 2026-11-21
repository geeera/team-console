#!/usr/bin/env node
// Not a Vitest spec: tools/release/node-runtime.mjs runs before `npm ci`, so its fixtures run with Node's builtin
// `assert`, from security.yml's `workflow-lint` job (the tools/ci/audit-gate.test.mjs pattern). Nothing here touches
// the network or gpgv: each check of the trust chain is fed fixtures, and each refusal is asserted.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertKeyringIsPinned,
  assertSumsListPin,
  binaryKeyringOf,
  keyringFingerprints,
  missedSecurityReleases,
  nodeTarballOf,
  parseFingerprints,
  parsePin,
  signerOf,
} from './node-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEYRING = readFileSync(path.join(root, 'apps/runner/node/release-keys.asc'), 'utf8');
const SIGNER = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356';
const OTHER = 'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C';
const STRANGER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PINNED = [SIGNER, OTHER];

const sums = {
  'darwin-arm64': 'a'.repeat(64),
  'darwin-x64': 'b'.repeat(64),
  'linux-x64': 'c'.repeat(64),
  'linux-arm64': 'd'.repeat(64),
};
const pinText = (overrides = {}) => JSON.stringify({ version: '22.23.5', sha256: sums, ...overrides });
const PIN = parsePin(pinText());

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

// --- the pin -------------------------------------------------------------------------------------------------
test('reads a pin with a version and one sha256 per platform', () => {
  assert.deepStrictEqual(PIN, { version: '22.23.5', major: 22, sha256: sums });
});

test('refuses a pin below 22.14, a missing or extra platform, a bad sum or an extra key', () => {
  assert.throws(() => parsePin(pinText({ version: '22.13.9' })), /below 22\.14\.0/);
  assert.throws(() => parsePin(pinText({ version: 'v22.23.5' })), /not a Node\.js release version/);
  const { 'linux-arm64': _dropped, ...three } = sums;
  void _dropped;
  assert.throws(() => parsePin(pinText({ sha256: three })), /one sha256 for each/);
  assert.throws(() => parsePin(pinText({ sha256: { ...sums, 'win-x64': 'e'.repeat(64) } })), /one sha256 for each/);
  assert.throws(() => parsePin(pinText({ sha256: { ...sums, 'linux-x64': 'C'.repeat(64) } })), /64 lowercase hex/);
  assert.throws(() => parsePin(pinText({ url: 'https://example.com' })), /exactly version and sha256/);
});

test('the committed pin parses', () => {
  parsePin(readFileSync(path.join(root, 'apps/runner/node/node-release.json'), 'utf8'));
});

// --- the pinned fingerprints and the keyring -----------------------------------------------------------------
test('parses the workflow fingerprint list and refuses a short, lowercase or repeated one', () => {
  assert.deepStrictEqual(parseFingerprints(` ${SIGNER}\n  ${OTHER} `), PINNED);
  assert.throws(() => parseFingerprints(''), /must be distinct/);
  assert.throws(() => parseFingerprints(SIGNER.toLowerCase()), /must be distinct/);
  assert.throws(() => parseFingerprints(SIGNER.slice(1)), /must be distinct/);
  assert.throws(() => parseFingerprints(`${SIGNER} ${SIGNER}`), /must be distinct/);
});

test('computes the v4 primary fingerprint of every key in the committed keyring', () => {
  const found = keyringFingerprints(KEYRING);
  assert.strictEqual(found.length, 8);
  assert.ok(found.includes(SIGNER));
  assert.ok(found.every((fingerprint) => /^[0-9A-F]{40}$/.test(fingerprint)));
});

test('accepts the keyring only when it holds exactly the pinned keys', () => {
  const found = keyringFingerprints(KEYRING);
  assertKeyringIsPinned(KEYRING, [...found].reverse());
  assert.throws(() => assertKeyringIsPinned(KEYRING, found.slice(1)), /not exactly the pinned ones/);
  assert.throws(() => assertKeyringIsPinned(KEYRING, [...found, STRANGER]), /not exactly the pinned ones/);
  // A key appended to the file without its fingerprint in the workflow is refused.
  const first = KEYRING.slice(0, KEYRING.indexOf('-----END PGP PUBLIC KEY BLOCK-----') + 35);
  assert.throws(() => assertKeyringIsPinned(`${KEYRING}\n${first}`, found), /not exactly the pinned ones/);
});

test('refuses a keyring with no armored key and a corrupted packet', () => {
  assert.throws(() => keyringFingerprints('nothing here'), /no armored public key block/);
  assert.throws(
    () => keyringFingerprints('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----'),
    /not an OpenPGP packet/,
  );
});

test('the binary keyring for gpgv starts with a public key packet', () => {
  const bytes = binaryKeyringOf(KEYRING);
  assert.ok(bytes.length > 1000);
  assert.strictEqual(bytes[0] & 0x80, 0x80);
});

// --- gpgv's verdict --------------------------------------------------------------------------------------------
const validsig = (primary, signing = primary) =>
  `[GNUPG:] VALIDSIG ${signing} 2026-11-11 1762819200 0 4 0 1 10 01 ${primary}`;
const status = (...lines) => ['[GNUPG:] NEWSIG', '[GNUPG:] GOODSIG 20B1A390B168D356 releaser', ...lines, ''].join('\n');

test('names the pinned primary key of one good signature, a signing subkey included', () => {
  assert.strictEqual(signerOf(status(validsig(SIGNER)), PINNED), SIGNER);
  assert.strictEqual(signerOf(status(validsig(SIGNER, 'B'.repeat(40))), PINNED), SIGNER);
});

test('refuses a signature by a key that is not pinned, even one gpgv accepted', () => {
  assert.throws(() => signerOf(status(validsig(STRANGER)), PINNED), /not a pinned Node\.js release key/);
});

test('refuses no signature, two signatures, and every bad, expired, revoked or unverifiable one', () => {
  assert.throws(() => signerOf('', PINNED), /exactly one good signature \(found 0\)/);
  assert.throws(() => signerOf(status(validsig(SIGNER), validsig(OTHER)), PINNED), /found 2/);
  for (const bad of ['BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY', 'NODATA', 'FAILURE']) {
    assert.throws(() => signerOf(status(validsig(SIGNER), `[GNUPG:] ${bad} x`), PINNED), new RegExp(bad));
  }
});

// --- the signed sums against the pin ---------------------------------------------------------------------------
const shasums = (entries) => `${entries.map(([sum, name]) => `${sum}  ${name}`).join('\n')}\n`;
const allPinned = () =>
  Object.entries(sums).map(([platform, sum]) => [sum, nodeTarballOf('22.23.5', platform)]);

test('accepts signed sums that list every pinned tarball with its pinned sum', () => {
  assertSumsListPin(shasums([['e'.repeat(64), 'node-v22.23.5.tar.gz'], ...allPinned()]), PIN);
});

test('refuses a pinned tarball the signed sums do not list, list twice, or list with another sum', () => {
  assert.throws(() => assertSumsListPin(shasums(allPinned().slice(1)), PIN), /0 times, not once/);
  assert.throws(() => assertSumsListPin(shasums([...allPinned(), allPinned()[0]]), PIN), /2 times, not once/);
  const changed = allPinned().map(([sum, name], index) => [index === 2 ? 'f'.repeat(64) : sum, name]);
  assert.throws(() => assertSumsListPin(shasums(changed), PIN), /another sha256/);
});

// --- R-NODE-2: security releases the pin misses ----------------------------------------------------------------
test('lists the later security releases of the pinned major line, oldest first', () => {
  const index = [
    { version: 'v24.9.0', security: true },
    { version: 'v22.24.1', security: true },
    { version: 'v22.24.0', security: false },
    { version: 'v22.23.6', security: true },
    { version: 'v22.23.5', security: true },
    { version: 'v22.23.4', security: true },
    { version: 'nonsense', security: true },
  ];
  assert.deepStrictEqual(missedSecurityReleases(index, PIN), ['22.23.6', '22.24.1']);
  assert.deepStrictEqual(missedSecurityReleases([{ version: 'v22.23.5', security: true }], PIN), []);
  assert.throws(() => missedSecurityReleases({}, PIN), /not a list/);
});

if (failures > 0) {
  console.error(`${String(failures)} failed`);
  process.exit(1);
}
