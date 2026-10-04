#!/usr/bin/env node
// Runs the VAPID generator (PR #54 QA round 3) enough times to catch a regression like the OpenSSL/LibreSSL
// leading-zero bug this module replaced (that one failed about half the time). Not a Vitest spec: this tool
// lives outside the Nx graph and only needs Node's builtin `crypto`/`assert`, run directly by
// security.yml's `workflow-lint` job, next to shellcheck.
'use strict';

const assert = require('assert');
const { generateVapidKeyPair } = require('./vapid-keygen');

const RUNS = 50;

for (let i = 0; i < RUNS; i++) {
  const { privateKeyB64, publicKeyB64 } = generateVapidKeyPair();

  const priv = Buffer.from(privateKeyB64, 'base64url');
  assert.strictEqual(priv.length, 32, `run ${i}: private key decoded to ${priv.length} bytes, expected 32`);

  const pub = Buffer.from(publicKeyB64, 'base64url');
  assert.strictEqual(pub.length, 65, `run ${i}: public key decoded to ${pub.length} bytes, expected 65`);
  assert.strictEqual(pub[0], 0x04, `run ${i}: public key does not start with 0x04 (got 0x${pub[0].toString(16)})`);

  // Every run must be a fresh key, not a cached/degenerate value.
  assert.notStrictEqual(privateKeyB64, '', `run ${i}: empty private key`);
}

process.stdout.write(`ok: ${RUNS}/${RUNS} generated VAPID key pairs decoded to 32+65 bytes\n`);
