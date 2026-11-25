#!/usr/bin/env node
// ci.yml's `lint-test-build-shard` test shards (#992): which Nx projects does shard <index> of <total> run?
// Reads the JSON array `nx show projects --json` prints on stdin and prints the shard's projects, comma-separated,
// for `nx run-many --projects=…` (an empty line for a shard with nothing to run).
//
//   nx show projects --with-target test --json \
//     | node tools/ci/shard-projects.mjs <index>/<total> [--always a,b] [--weights a=14,b=5]
//
// Every job of the matrix runs this on the same list and gets its own slice of one split: each project lands in
// exactly one shard, so no test is skipped and none runs twice. The split is by weight (how long a project's
// tests take, in units of an ordinary project, which counts 1), heaviest first onto the lightest shard, so two
// slow projects do not share a shard. A weight for a project that is not in the list is ignored: a stale weight must not break CI.
//
// Fails closed: a list that is not a JSON array of plain project names, or a malformed argument, exits non-zero
// with nothing on stdout, so the caller's `$(…)` under `set -e` stops the job instead of running no tests.
// The failure line is constant text, never the input. No npm dependency, as the other tools/ci scripts.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// What Nx project names look like here. Nothing a shell or `--projects` would read as more than a name
// (no comma, space, quote, glob or leading dash).
const PROJECT_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/;
const SHARD = /^([1-9][0-9]?)\/([1-9][0-9]?)$/;
const DEFAULT_WEIGHT = 1;

/** An argument or an input this script cannot use; `message` is constant text, safe in a workflow command. */
export class InputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InputError';
  }
}

/** `{ index, total }` of an `<index>/<total>` argument, 1-based. */
export function parseShard(text) {
  const match = typeof text === 'string' ? SHARD.exec(text) : null;
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (match === null || index > total) {
    throw new InputError('<index>/<total> is not a shard such as 1/2');
  }
  return { index, total };
}

function assertProjectName(name, where) {
  if (typeof name !== 'string' || !PROJECT_NAME.test(name)) {
    throw new InputError(`${where} holds something that is not a plain project name`);
  }
}

/** The project names of a comma-separated `--always` value. */
export function parseNames(text) {
  const names = text.split(',').filter((name) => name !== '');
  for (const name of names) {
    assertProjectName(name, '--always');
  }
  return names;
}

/** The `name → weight` map of a comma-separated `--weights name=weight` value. */
export function parseWeights(text) {
  const weights = new Map();
  for (const entry of text.split(',').filter((part) => part !== '')) {
    const separator = entry.lastIndexOf('=');
    const name = entry.slice(0, Math.max(separator, 0));
    const weight = entry.slice(separator + 1);
    assertProjectName(name, '--weights');
    if (!/^[1-9][0-9]{0,4}$/.test(weight)) {
      throw new InputError('--weights holds a weight that is not a whole number from 1 to 99999');
    }
    weights.set(name, Number(weight));
  }
  return weights;
}

/** The project names of `nx show projects --json` output. */
export function parseProjects(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new InputError('the project list on stdin is not JSON', { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new InputError('the project list on stdin is not a JSON array');
  }
  for (const name of parsed) {
    assertProjectName(name, 'the project list on stdin');
  }
  return parsed;
}

/**
 * Splits `projects` into `total` shards: heaviest first, each onto the shard that is lightest so far (the
 * lowest-numbered one on a tie). Depends only on the set of names and the weights, not on the input order.
 */
export function splitIntoShards(projects, total, weights = new Map()) {
  const weightOf = (name) => weights.get(name) ?? DEFAULT_WEIGHT;
  const byWeight = [...new Set(projects)].sort(
    (a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const shards = Array.from({ length: total }, () => ({ load: 0, projects: [] }));
  for (const name of byWeight) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.projects.push(name);
    lightest.load += weightOf(name);
  }
  return shards.map((shard) => shard.projects.sort());
}

function parseArguments(argv) {
  const [shard, ...options] = argv;
  const parsed = { ...parseShard(shard), always: [], weights: new Map() };
  for (let at = 0; at < options.length; at += 2) {
    const value = options[at + 1];
    if (value === undefined) {
      throw new InputError('an option is missing its value');
    }
    if (options[at] === '--always') {
      parsed.always = parseNames(value);
    } else if (options[at] === '--weights') {
      parsed.weights = parseWeights(value);
    } else {
      throw new InputError('unknown option; only --always and --weights exist');
    }
  }
  return parsed;
}

function main(argv) {
  let line;
  try {
    const { index, total, always, weights } = parseArguments(argv);
    const projects = [...parseProjects(readFileSync(0, 'utf8')), ...always];
    line = (splitIntoShards(projects, total, weights)[index - 1] ?? []).join(',');
  } catch (error) {
    const reason = error instanceof InputError ? error.message : 'could not read the project list on stdin';
    process.stderr.write(
      `::error::shard-projects: ${reason}. See #992.\n` +
        'usage: shard-projects.mjs <index>/<total> [--always a,b] [--weights a=14,b=5] < projects.json\n',
    );
    return 1;
  }
  process.stdout.write(`${line}\n`);
  return 0;
}

/** Same check as changed-paths.mjs: true only when Node was asked to run this file, however its path is spelled. */
function isRunAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  process.exit(main(process.argv.slice(2)));
}
