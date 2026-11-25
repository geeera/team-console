#!/usr/bin/env node
// Not a Vitest spec, as tools/ci/changed-paths.test.mjs: plain Node, run by security.yml's `workflow-lint` job.
// What matters most here (#992): the shards of one split cover every project exactly once, whatever the order
// the list arrives in, and anything the script cannot read stops the job instead of running no tests.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  InputError,
  parseNames,
  parseProjects,
  parseScope,
  parseShard,
  parseWeights,
  selectShard,
  splitIntoShards,
} from './shard-projects.mjs';

const SCRIPT = fileURLToPath(new URL('./shard-projects.mjs', import.meta.url));
const assertInputError = (call, message) =>
  assert.throws(call, (error) => {
    assert.ok(error instanceof InputError, `${message}: an InputError`);
    assert.strictEqual(error.message, message);
    return true;
  });

// --- parseShard ---
assert.deepStrictEqual(parseShard('1/2'), { index: 1, total: 2 });
assert.deepStrictEqual(parseShard('3/3'), { index: 3, total: 3 });
for (const bad of ['0/2', '3/2', '1/0', '1', '1/2/3', ' 1/2', '1/2\n', '-1/2', '1/100', '', undefined]) {
  assertInputError(() => parseShard(bad), '<index>/<total> is not a shard such as 1/2');
}

// --- parseProjects: only a JSON array of plain names. ---
assert.deepStrictEqual(parseProjects('["api","console-shared-ui","@scope/lib"]'), [
  'api',
  'console-shared-ui',
  '@scope/lib',
]);
assert.deepStrictEqual(parseProjects('[]\n'), []);
assertInputError(() => parseProjects(''), 'the project list on stdin is not JSON');
assertInputError(() => parseProjects('NX failed'), 'the project list on stdin is not JSON');
assertInputError(() => parseProjects('{"api":1}'), 'the project list on stdin is not a JSON array');
for (const name of ['a,b', 'a b', '--all', '*', 'a"b', "a'b", 'a\nb', '$(id)', '']) {
  assertInputError(
    () => parseProjects(JSON.stringify(['api', name])),
    'the project list on stdin holds something that is not a plain project name',
  );
}
assertInputError(
  () => parseProjects('["api", 7]'),
  'the project list on stdin holds something that is not a plain project name',
);

// --- parseNames / parseWeights ---
assert.deepStrictEqual(parseNames('workspace-checks'), ['workspace-checks']);
assert.deepStrictEqual(parseNames('a,,b,'), ['a', 'b']);
assertInputError(() => parseNames('a,--all'), '--always holds something that is not a plain project name');
assert.deepStrictEqual(
  [...parseWeights('api=90,runner=100')],
  [
    ['api', 90],
    ['runner', 100],
  ],
);
assert.deepStrictEqual([...parseWeights('')], []);
for (const bad of ['api=0', 'api=-1', 'api=1.5', 'api=', 'api=1e3', 'api=100000']) {
  assertInputError(
    () => parseWeights(bad),
    '--weights holds a weight that is not a whole number from 1 to 99999',
  );
}
for (const bad of ['=5', 'api', 'a b=5']) {
  assertInputError(() => parseWeights(bad), '--weights holds something that is not a plain project name');
}

// --- splitIntoShards: a partition, whatever the input order, and balanced by weight. ---
const PROJECTS = Array.from({ length: 87 }, (_, at) => `project-${String(at).padStart(2, '0')}`);
const WEIGHTS = new Map([
  ['project-03', 100],
  ['project-04', 90],
  ['project-50', 35],
  ['project-51', 30],
  ['not-a-project', 500],
]);
const loadOf = (shard) => shard.reduce((sum, name) => sum + (WEIGHTS.get(name) ?? 1), 0);
for (const total of [1, 2, 3, 4, 7]) {
  const shards = splitIntoShards(PROJECTS, total, WEIGHTS);
  assert.strictEqual(shards.length, total);
  // Every project exactly once: nothing skipped, nothing run twice.
  assert.deepStrictEqual(shards.flat().sort(), PROJECTS, `${total} shards cover every project once`);
  // The same split from a reversed list: each matrix job computes it alone and must agree with the others.
  assert.deepStrictEqual(splitIntoShards([...PROJECTS].reverse(), total, WEIGHTS), shards);
  // A stale weight (a project that is gone) adds nothing.
  assert.ok(!shards.flat().includes('not-a-project'));
}
const [first, second] = splitIntoShards(PROJECTS, 2, WEIGHTS);
// The two slow projects are apart, and the loads are level (338 units in all).
assert.notStrictEqual(first.includes('project-03'), first.includes('project-04'));
assert.ok(Math.abs(loadOf(first) - loadOf(second)) <= 1, `${loadOf(first)} vs ${loadOf(second)}`);
// Without weights: by count.
assert.deepStrictEqual(
  splitIntoShards(PROJECTS, 3).map((shard) => shard.length),
  [29, 29, 29],
);
// A name given twice (the list and `--always`) is one project.
assert.deepStrictEqual(splitIntoShards(['a', 'b', 'a'], 2), [['a'], ['b']]);
// More shards than projects: the rest are empty, not an error.
assert.deepStrictEqual(splitIntoShards(['a'], 3), [['a'], [], []]);
assert.deepStrictEqual(splitIntoShards([], 2), [[], []]);

// --- parseScope / selectShard (#999): a full run with nothing to test is an error, an affected one is not. ---
assert.strictEqual(parseScope('affected'), 'affected');
assert.strictEqual(parseScope('run-many'), 'run-many');
for (const bad of ['', 'all', 'Run-Many', 'run-many ', 'affected,run-many', undefined]) {
  assertInputError(() => parseScope(bad), '--scope is neither affected nor run-many');
}
const shardOf = (options) => selectShard({ index: 1, total: 2, ...options });
assert.deepStrictEqual(shardOf({ listed: ['a', 'b', 'c'], scope: 'run-many' }), ['a', 'c']);
assert.deepStrictEqual(shardOf({ listed: ['a'], always: ['b'], index: 2, scope: 'run-many' }), ['b']);
// Nothing listed: `--always` must not hide it, in the shard that gets the always-project or in the other one.
for (const index of [1, 2]) {
  assertInputError(
    () => shardOf({ listed: [], always: ['workspace-checks'], index, scope: 'run-many' }),
    'a full run listed no project with a test target',
  );
}
assertInputError(
  () => shardOf({ listed: ['a'], index: 2, scope: 'run-many' }),
  'a full run left this shard no project to test',
);
// An affected run, and a call that names no scope, may have nothing to do.
assert.deepStrictEqual(shardOf({ listed: [], scope: 'affected' }), []);
assert.deepStrictEqual(shardOf({ listed: [], always: ['workspace-checks'], index: 2 }), []);
assert.deepStrictEqual(shardOf({ listed: [], always: ['workspace-checks'] }), ['workspace-checks']);

// --- The script itself: one line on stdout, or nothing and a non-zero exit. ---
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
const list = JSON.stringify(['api', 'runner', 'console', 'hooks']);
const weights = ['--weights', 'api=90,runner=100'];
const one = run(['1/2', ...weights], list);
const two = run(['2/2', ...weights], list);
assert.strictEqual(one.status, 0, one.stderr);
// The heaviest alone; everything lighter fills the other shard up to it.
assert.strictEqual(one.stdout, 'runner\n');
assert.strictEqual(two.stdout, 'api,console,hooks\n');
// `--always` adds a project the list lacks and does not double one it has.
const always = [1, 2].map((index) =>
  run([`${index}/2`, '--always', 'workspace-checks,api'], list).stdout.trim(),
);
assert.deepStrictEqual(always.flatMap((line) => line.split(',')).sort(), [
  'api',
  'console',
  'hooks',
  'runner',
  'workspace-checks',
]);
// An empty shard is an empty line and success: the caller skips it out loud.
for (const scope of [[], ['--scope', 'affected']]) {
  const empty = run(['2/2', ...scope], '["api"]');
  assert.strictEqual(empty.status, 0);
  assert.strictEqual(empty.stdout, '\n');
  const nothingAffected = run(['2/2', ...scope, '--always', 'workspace-checks'], '[]');
  assert.strictEqual(nothingAffected.status, 0);
  assert.strictEqual(nothingAffected.stdout, '\n');
}
// A full run splits as any other when there is something in every shard.
const full = [1, 2].map((index) => run([`${index}/2`, '--scope', 'run-many', ...weights], list));
assert.deepStrictEqual(
  full.map((result) => [result.status, result.stdout]),
  [
    [0, 'runner\n'],
    [0, 'api,console,hooks\n'],
  ],
);

// Fails closed, with constant text: nothing of the input reaches the workflow command.
for (const [args, input] of [
  [['1/2'], ''],
  [['1/2'], 'NX   Could not find project'],
  [['1/2'], '["api","::error::x"]'],
  [['1/2'], '["api","a b"]'],
  [['3/2'], list],
  [[], list],
  [['1/2', '--always'], list],
  [['1/2', '--only', 'api'], list],
  [['1/2', '--weights', 'api=fast'], list],
  [['1/2', '--always', '--all'], list],
  [['1/2', '--scope', 'everything'], list],
  [['1/2', '--scope'], list],
  // #999: a full run that would test nothing, in either shard, with or without the always-project.
  [['1/2', '--scope', 'run-many', '--always', 'workspace-checks'], '[]'],
  [['2/2', '--scope', 'run-many', '--always', 'workspace-checks'], '[]'],
  [['1/2', '--scope', 'run-many'], '[]'],
  [['2/2', '--scope', 'run-many'], '["api"]'],
]) {
  const failed = run(args, input);
  assert.strictEqual(failed.status, 1, JSON.stringify(args));
  assert.strictEqual(failed.stdout, '', JSON.stringify(args));
  assert.match(failed.stderr, /^::error::shard-projects: [a-z<>/ ;,.A-Z0-9-]+\. See #992\.\n/);
  assert.ok(!failed.stderr.includes('a b') && !failed.stderr.includes('::error::x'));
}

process.stdout.write('ok: shard-projects splits every project into exactly one shard and fails closed\n');
