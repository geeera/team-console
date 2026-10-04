#!/usr/bin/env node
// VAPID (P-256) key pair generation for tools/owner-setup/set-secrets.sh.
//
// Node's built-in `crypto` only — no npm package runs next to the Cloudflare/GitHub credentials
// set-secrets.sh handles. JWK export is used instead of parsing OpenSSL's `-text` output: OpenSSL (in
// particular the LibreSSL build macOS ships as `/usr/bin/openssl`) prints the private scalar as an ASN.1
// integer, which drops or gains a leading zero byte depending on the value — about half of generated keys
// came out as 33 bytes, silently invalid for Web Push (PR #54 QA round 3, reproduced with 2000 runs split
// across LibreSSL/OpenSSL). JWK's `d`/`x`/`y` are fixed-width per RFC 7518 and were exactly 32 bytes across
// 2000 generations in the same test — verified again by `vapid-keygen.test.js`, which this module is built
// to be tested by.
//
// Usage: `node vapid-keygen.js` prints two lines to stdout — the private key, then the public key, both
// base64url with no padding — and exits non-zero without printing anything if either fails validation.
// Nothing here ever takes a secret as a CLI argument or writes one to a file.
'use strict';

const crypto = require('crypto');

function generateVapidKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });

  const d = Buffer.from(jwk.d, 'base64url');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  if (d.length !== 32) {
    throw new Error(`private scalar decoded to ${d.length} bytes, expected 32`);
  }
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`public coordinate decoded to ${x.length}/${y.length} bytes, expected 32/32`);
  }

  const publicPoint = Buffer.concat([Buffer.from([0x04]), x, y]);
  if (publicPoint.length !== 65 || publicPoint[0] !== 0x04) {
    throw new Error(`uncompressed public point is ${publicPoint.length} bytes starting 0x${publicPoint[0].toString(16)}, expected 65 starting 0x04`);
  }

  return {
    privateKeyB64: d.toString('base64url'),
    publicKeyB64: publicPoint.toString('base64url'),
  };
}

module.exports = { generateVapidKeyPair };

if (require.main === module) {
  const { privateKeyB64, publicKeyB64 } = generateVapidKeyPair();
  process.stdout.write(`${privateKeyB64}\n${publicKeyB64}\n`);
}
