#!/usr/bin/env node
// The Node.js binary the runner release ships (#634 PR 5, threat model C11 R-NODE-1/R-NODE-2). Used by
// release-runner.yml (`fetch`) and node-runtime-check.yml (`verify-sums`, `security-check`).
//
// Trust chain, all of it in this repository: the version and each platform's tarball sha256 are pinned in
// apps/runner/node/node-release.json (reviewed like a lockfile); Node's release keys are a committed keyring
// (apps/runner/node/release-keys.asc), never fetched from a keyserver; the workflow pins the primary fingerprints a
// signature may come from (NODE_RELEASE_KEY_FINGERPRINTS). `SHASUMS256.txt.asc` must carry exactly one good
// signature by one of those keys, the signed text must list each pinned sum, and every downloaded tarball must hash
// to its pinned sum before anything is extracted. Any other outcome stops the release.
//
// Not a Vitest spec's subject only: no npm dependency, so it runs before `npm ci`; `gpgv` (Ubuntu ships it) does
// the OpenPGP signature check, and this file judges gpgv's machine-readable status, never its exit code alone.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_DIST = 'https://nodejs.org/dist';
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
/** `--disable-sigusr1`, which the launcher passes on every path, needs 22.14 or later. */
const MINIMUM = [22, 14, 0];

const HEX64 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9A-F]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function versionParts(version) {
  const match = VERSION.exec(version);
  if (match === null) {
    throw new Error(`${JSON.stringify(version)} is not a Node.js release version (MAJOR.MINOR.PATCH)`);
  }
  return match.slice(1, 4).map(Number);
}

export function compareVersions(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {
      return x[i] < y[i] ? -1 : 1;
    }
  }
  return 0;
}

/** The pin file, checked whole: a version at or above the minimum and one sha256 for each platform, nothing else. */
export function parsePin(text) {
  const pin = JSON.parse(text);
  if (typeof pin !== 'object' || pin === null || Array.isArray(pin)) {
    throw new Error('the Node.js pin must be an object');
  }
  const keys = Object.keys(pin).sort();
  if (keys.join(',') !== 'sha256,version') {
    throw new Error(`the Node.js pin holds exactly version and sha256 (found ${keys.join(', ')})`);
  }
  const parts = versionParts(pin.version);
  if (compareVersions(pin.version, MINIMUM.join('.')) < 0) {
    throw new Error(`Node.js ${pin.version} is below ${MINIMUM.join('.')}, which the launcher needs`);
  }
  const sums = pin.sha256;
  if (
    typeof sums !== 'object' ||
    sums === null ||
    Object.keys(sums).sort().join(',') !== [...PLATFORMS].sort().join(',')
  ) {
    throw new Error(`the Node.js pin needs one sha256 for each of ${PLATFORMS.join(', ')} and nothing else`);
  }
  for (const platform of PLATFORMS) {
    if (typeof sums[platform] !== 'string' || !HEX64.test(sums[platform])) {
      throw new Error(`the Node.js pin's sha256 for ${platform} is not 64 lowercase hex characters`);
    }
  }
  return { version: pin.version, major: parts[0], sha256: { ...sums } };
}

/** The pinned fingerprints as the workflow passes them: 40 uppercase hex each, separated by white space. */
export function parseFingerprints(text) {
  const list = text.split(/\s+/).filter((item) => item !== '');
  if (
    list.length === 0 ||
    !list.every((item) => FINGERPRINT.test(item)) ||
    new Set(list).size !== list.length
  ) {
    throw new Error(
      'NODE_RELEASE_KEY_FINGERPRINTS must be distinct 40-hex uppercase primary key fingerprints',
    );
  }
  return list;
}

export const nodeTarballOf = (version, platform) => `node-v${version}-${platform}.tar.gz`;
export const nodeUrlOf = (version, file) => `${NODE_DIST}/v${version}/${file}`;

/**
 * gpgv's `--status-fd` output, judged: no bad, expired, revoked or unverifiable signature, exactly one VALIDSIG, and
 * that signature's primary key fingerprint (the last field, so a releaser's signing subkey counts as its primary) is
 * pinned. Returns that fingerprint.
 */
export function signerOf(status, pinned) {
  const lines = status.split('\n').filter((line) => line.startsWith('[GNUPG:] '));
  const refused = lines.find((line) =>
    /^\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY|NODATA|FAILURE)\b/.test(line),
  );
  if (refused !== undefined) {
    throw new Error(`the SHASUMS256.txt signature is refused (${refused.split(' ').slice(1, 2).join('')})`);
  }
  const valid = lines.filter((line) => line.startsWith('[GNUPG:] VALIDSIG '));
  if (valid.length !== 1) {
    throw new Error(`SHASUMS256.txt must carry exactly one good signature (found ${String(valid.length)})`);
  }
  const fields = valid[0].split(' ');
  const primary = fields.at(-1);
  if (!FINGERPRINT.test(primary) || !pinned.includes(primary)) {
    throw new Error(`SHASUMS256.txt is signed by ${primary}, which is not a pinned Node.js release key`);
  }
  return primary;
}

/** The signed `SHASUMS256.txt` lists each platform's tarball exactly once, with the pinned sum. */
export function assertSumsListPin(shasums, pin) {
  for (const platform of PLATFORMS) {
    const name = nodeTarballOf(pin.version, platform);
    const lines = shasums.split('\n').filter((line) => line.endsWith(`  ${name}`));
    if (lines.length !== 1) {
      throw new Error(`the signed SHASUMS256.txt lists ${name} ${String(lines.length)} times, not once`);
    }
    const sum = lines[0].slice(0, -`  ${name}`.length);
    if (sum !== pin.sha256[platform]) {
      throw new Error(`the signed SHASUMS256.txt names another sha256 for ${name} than the pin`);
    }
  }
}

/** Bytes of each ASCII-armored block in `text`, its checksum line and headers left out. */
export function dearmor(text) {
  const blocks = [];
  const pattern = /-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/g;
  for (const match of text.matchAll(pattern)) {
    const lines = match[1].split(/\r?\n/);
    // Armor headers (`Comment: …`) end at the first empty line; without them the body starts at once.
    const blank = lines.indexOf('');
    const hasHeaders = blank > 0 && lines.slice(0, blank).every((line) => /^[A-Za-z-]+: /.test(line));
    const base64 = lines
      .slice(hasHeaders ? blank + 1 : 0)
      .filter((line) => line !== '' && !line.startsWith('='))
      .join('');
    blocks.push(Buffer.from(base64, 'base64'));
  }
  if (blocks.length === 0) {
    throw new Error('the keyring holds no armored public key block');
  }
  return blocks;
}

/** OpenPGP packets (RFC 4880 section 4.2) as `{ tag, body }`; partial lengths never occur in a key. */
export function packetsOf(bytes) {
  const packets = [];
  let at = 0;
  while (at < bytes.length) {
    const head = bytes[at];
    if ((head & 0x80) === 0) {
      throw new Error('not an OpenPGP packet');
    }
    let tag;
    let length;
    let start;
    if ((head & 0x40) !== 0) {
      tag = head & 0x3f;
      const first = bytes[at + 1];
      if (first < 192) {
        length = first;
        start = at + 2;
      } else if (first < 224) {
        length = ((first - 192) << 8) + bytes[at + 2] + 192;
        start = at + 3;
      } else if (first === 255) {
        length = bytes.readUInt32BE(at + 2);
        start = at + 6;
      } else {
        throw new Error('a partial-length packet in a key');
      }
    } else {
      tag = (head >> 2) & 0x0f;
      const type = head & 0x03;
      if (type === 3) {
        throw new Error('an indeterminate-length packet in a key');
      }
      const size = [1, 2, 4][type];
      length =
        size === 1 ? bytes[at + 1] : size === 2 ? bytes.readUInt16BE(at + 1) : bytes.readUInt32BE(at + 1);
      start = at + 1 + size;
    }
    if (start + length > bytes.length) {
      throw new Error('a truncated OpenPGP packet');
    }
    packets.push({ tag, body: bytes.subarray(start, start + length) });
    at = start + length;
  }
  return packets;
}

/** A v4 key's fingerprint: SHA-1 over 0x99, the two-byte body length and the public key packet body. */
export function v4FingerprintOf(body) {
  if (body[0] !== 4) {
    throw new Error(`a version ${String(body[0])} key; only v4 keys are pinned`);
  }
  const prefix = Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]);
  return createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase();
}

/** The primary key fingerprint of each key in an armored keyring, in file order. */
export function keyringFingerprints(text) {
  return dearmor(text).flatMap((block) =>
    packetsOf(block)
      .filter((packet) => packet.tag === 6)
      .map((packet) => v4FingerprintOf(packet.body)),
  );
}

/** The keyring holds exactly the pinned keys: a key added to the file alone never signs a release. */
export function assertKeyringIsPinned(armored, pinned) {
  const found = keyringFingerprints(armored);
  const sorted = (list) => [...list].sort().join(' ');
  if (found.length !== new Set(found).size || sorted(found) !== sorted(pinned)) {
    throw new Error(
      `the keyring's keys (${sorted(found)}) are not exactly the pinned ones (${sorted(pinned)})`,
    );
  }
}

/** The binary keyring gpgv reads: the armored blocks' bytes, concatenated. */
export function binaryKeyringOf(armored) {
  return Buffer.concat(dearmor(armored));
}

export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Index entries newer than the pin on the pin's major line that Node marks `security: true`: the fixes this release
 * does not carry yet (R-NODE-2).
 */
export function missedSecurityReleases(index, pin) {
  if (!Array.isArray(index)) {
    throw new Error('the Node.js release index is not a list');
  }
  return index
    .map((entry) => ({
      version: String(entry?.version ?? '').replace(/^v/, ''),
      security: entry?.security === true,
    }))
    .filter((entry) => VERSION.test(entry.version) && entry.security)
    .filter(
      (entry) =>
        versionParts(entry.version)[0] === pin.major && compareVersions(entry.version, pin.version) > 0,
    )
    .map((entry) => entry.version)
    .sort(compareVersions);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_FILE = path.join(repoRoot, 'apps/runner/node/node-release.json');
const KEYRING_FILE = path.join(repoRoot, 'apps/runner/node/release-keys.asc');

function download(url, file) {
  execFileSync('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '--retry', '3', '-o', file, url], {
    stdio: 'inherit',
  });
}

/** Downloads `SHASUMS256.txt.asc`, has gpgv check it against the pinned keyring, and checks the pin against it. */
function verifySums(work, pin, pinned) {
  const armored = readFileSync(KEYRING_FILE, 'utf8');
  assertKeyringIsPinned(armored, pinned);
  const keyring = path.join(work, 'node-release-keys.gpg');
  writeFileSync(keyring, binaryKeyringOf(armored));
  const signed = path.join(work, 'SHASUMS256.txt.asc');
  download(nodeUrlOf(pin.version, 'SHASUMS256.txt.asc'), signed);
  const text = path.join(work, 'SHASUMS256.txt');
  let status;
  try {
    // `--output` writes the signed text only: what is checked below is exactly what the signature covers.
    status = execFileSync('gpgv', ['--status-fd', '1', '--keyring', keyring, '--output', text, signed], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    throw new Error(`gpgv refused SHASUMS256.txt.asc: ${String(error.stdout ?? error.message)}`);
  }
  const signer = signerOf(status, pinned);
  assertSumsListPin(readFileSync(text, 'utf8'), pin);
  console.log(`SHASUMS256.txt for Node.js ${pin.version}: signed by ${signer}, lists every pinned sum`);
}

/** Verifies the sums, downloads one platform's tarball, checks its pinned sum, then extracts only `bin/node`. */
function fetchNode(work, pin, pinned, platform, out) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`no Node.js is pinned for ${platform}`);
  }
  const name = nodeTarballOf(pin.version, platform);
  const tarball = path.join(work, name);
  download(nodeUrlOf(pin.version, name), tarball);
  if (sha256Of(readFileSync(tarball)) !== pin.sha256[platform]) {
    throw new Error(`${name} does not match its pinned sha256; nothing was extracted`);
  }
  const member = `node-v${pin.version}-${platform}/bin/node`;
  const tree = mkdtempSync(path.join(work, `${platform}-`));
  execFileSync('tar', ['-xzf', tarball, '-C', tree, '--no-same-owner', member], { stdio: 'inherit' });
  writeFileSync(out, readFileSync(path.join(tree, member)), { mode: 0o555 });
  console.log(`node ${pin.version} for ${platform}: sha256 ${pin.sha256[platform]} matches the pin`);
}

async function securityCheck(pin) {
  const response = await fetch(`${NODE_DIST}/index.json`);
  if (!response.ok) {
    throw new Error(`${NODE_DIST}/index.json answered ${String(response.status)}`);
  }
  const missed = missedSecurityReleases(await response.json(), pin);
  console.log(JSON.stringify({ pinned: pin.version, missed }));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const pin = parsePin(readFileSync(PIN_FILE, 'utf8'));
  if (command === 'security-check') {
    await securityCheck(pin);
    return;
  }
  const pinned = parseFingerprints(process.env.NODE_RELEASE_KEY_FINGERPRINTS ?? '');
  const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'node-runtime-'));
  try {
    verifySums(work, pin, pinned);
    if (command === 'fetch') {
      const [platform, out] = rest;
      if (platform === undefined || out === undefined) {
        throw new Error('usage: node-runtime.mjs fetch <platform> <out>');
      }
      fetchNode(work, pin, pinned, platform, out);
    } else if (command !== 'verify-sums') {
      throw new Error('usage: node-runtime.mjs verify-sums | fetch <platform> <out> | security-check');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
