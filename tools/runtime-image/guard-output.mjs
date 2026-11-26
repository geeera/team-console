#!/usr/bin/env node
// CI's `runtime-image` job prints text it did not write: the build's output, paths and `bin` values from the
// image, whatever the container answers and logs. The runner reads every line a step prints for workflow
// commands, in two forms: `::name::` at the start of a line, and the older `##[name]` anywhere in one. This
// prints its stdin between `::stop-commands::<token>` and `::<token>::`, so all of it is log text and nothing
// else (#1005, #1013).
//
//   … 2>&1 | node guard-output.mjs            reads everything first, then makes the token: the text cannot
//                                             hold or predict a token that did not exist while it was written
//   … 2>&1 | node guard-output.mjs --stream   prints as it reads, for output that is watched while it runs
//                                             (a build); the token is made first and never leaves the runner
//
// Exit codes: 0 printed, 2 it could not be. The step's own failure comes from `set -o pipefail`.
// No dependencies but check-runtime-tree.mjs beside it: the job runs this on the runner without `npm ci`.
import { randomBytes } from 'node:crypto';
import { isEntryPoint } from './check-runtime-tree.mjs';

/** @returns {string} */
const randomToken = () => randomBytes(16).toString('hex');

/**
 * A token the text does not contain. A random one is already not in it; the loop makes that a fact, not a chance.
 * @param {string} text
 * @param {() => string} [make]
 */
export function tokenFor(text, make = randomToken) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = make();
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('the token source gave something that is not a token');
    if (!text.includes(token)) return token;
  }
  throw new Error('no token that the text does not contain');
}

/**
 * @param {string} token
 * @returns {{ open: string, close: string }} the two marker lines, each with its newline
 */
export function markersOf(token) {
  return { open: `::stop-commands::${token}\n`, close: `::${token}::\n` };
}

/**
 * The text between its markers. It always ends its last line, so the closing marker starts a line of its own.
 * @param {string} text
 * @param {() => string} [make]
 */
export function guarded(text, make = randomToken) {
  const { open, close } = markersOf(tokenFor(text, make));
  return `${open}${text}${text.endsWith('\n') ? '' : '\n'}${close}`;
}

/**
 * @param {NodeJS.ReadableStream} input
 * @returns {Promise<string>}
 */
async function readAll(input) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {string | Buffer} chunk
 * @returns {Promise<void>}
 */
function write(output, chunk) {
  return new Promise((resolve, reject) => {
    output.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * @param {NodeJS.ReadableStream} input
 * @param {NodeJS.WritableStream} output
 * @returns {Promise<void>}
 */
async function stream(input, output) {
  const { open, close } = markersOf(randomToken());
  await write(output, open);
  let endsLine = true;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) continue;
    endsLine = bytes.at(-1) === 0x0a;
    await write(output, bytes);
  }
  await write(output, `${endsLine ? '' : '\n'}${close}`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<0 | 2>}
 */
async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--stream')) {
    console.error('usage: … | guard-output.mjs [--stream]');
    return 2;
  }
  try {
    if (argv[0] === '--stream') await stream(process.stdin, process.stdout);
    else await write(process.stdout, guarded(await readAll(process.stdin)));
    return 0;
  } catch (error) {
    console.error(`cannot guard the output: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (isEntryPoint(import.meta.url, 'guard-output.mjs')) process.exitCode = await main(process.argv.slice(2));
