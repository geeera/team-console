#!/usr/bin/env node
// Not a Vitest spec: ci.yml runs changed-paths.mjs before `npm ci`, so its test needs only Node and git too.
// Run by security.yml's `workflow-lint` job next to tools/ci/audit-gate.test.mjs. Every case builds a real
// scratch repository: what is under test is git's own listing of awkward paths, not a string we made up.
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentError, anyPathMatches, listChangedPaths, splitPaths } from './changed-paths.mjs';

const SCRIPT = fileURLToPath(new URL('./changed-paths.mjs', import.meta.url));
// The two patterns ci.yml passes, so a pattern JS reads differently from the old `grep -E` would show here.
const RUNNER =
  '^(apps/runner/|libs/shared/contracts/|libs/shared/plain-text/|libs/shared/redaction/|\\.github/workflows/ci\\.yml$|\\.github/actions/|tools/ci/changed-paths\\.mjs$|package\\.json$|package-lock\\.json$|\\.nvmrc$|nx\\.json$|tsconfig\\.base\\.json$|vitest\\.config\\.mts$)';
const ROOT_CONFIG =
  '^(\\.github/workflows/|\\.github/actions/|tools/ci/|package\\.json$|package-lock\\.json$|\\.nvmrc$|nx\\.json$|tsconfig\\.base\\.json$|eslint\\.config\\.mjs$|vitest\\.config\\.mts$)';

// --- splitPaths / anyPathMatches: NUL-separated, whole-path matching. ---
assert.deepStrictEqual(splitPaths(Buffer.from('a/b.ts\0c d.ts\0')), ['a/b.ts', 'c d.ts']);
assert.deepStrictEqual(splitPaths(Buffer.from('')), []);
assert.deepStrictEqual(splitPaths(Buffer.from('x\ny\0')), ['x\ny']);
assert.deepStrictEqual(splitPaths(Buffer.from([0x61, 0xff, 0xfe, 0x00])), ['aÿþ']);
assert.strictEqual(anyPathMatches(['apps/runner/a"b.ts'], RUNNER), true);
assert.strictEqual(anyPathMatches(['other/apps/runner/a.ts', 'docs/package.json'], RUNNER), false);
assert.strictEqual(anyPathMatches([], RUNNER), false);
// A line break inside one path is not a path boundary: neither anchor may match in the middle of it.
assert.strictEqual(anyPathMatches(['docs/x\napps/runner/a.ts'], RUNNER), false);
assert.strictEqual(anyPathMatches(['package.json\n.md'], ROOT_CONFIG), false);
assert.strictEqual(anyPathMatches(['apps/runner/x\ny.ts'], RUNNER), true);
// #983: the match ignores case — `Apps/Runner/x.ts` is `apps/runner/x.ts` on the macOS runner's volume.
assert.strictEqual(anyPathMatches(['Apps/Runner/x.ts'], RUNNER), true);
assert.strictEqual(anyPathMatches(['LIBS/shared/Contracts/src/index.ts'], RUNNER), true);
assert.strictEqual(anyPathMatches(['Package.JSON'], ROOT_CONFIG), true);
assert.strictEqual(anyPathMatches(['.GitHub/Workflows/ci.yml'], ROOT_CONFIG), true);
assert.strictEqual(anyPathMatches(['Docs/Apps/Runner/x.ts'], RUNNER), false);
// #983: a change to the scoping script, its test or the composite action runs every project.
assert.strictEqual(anyPathMatches(['tools/ci/changed-paths.mjs'], ROOT_CONFIG), true);
assert.strictEqual(anyPathMatches(['tools/ci/changed-paths.test.mjs'], ROOT_CONFIG), true);
assert.strictEqual(anyPathMatches(['.github/actions/setup-node-npm/action.yml'], ROOT_CONFIG), true);
assert.strictEqual(anyPathMatches(['docs/tools/ci/changed-paths.mjs'], ROOT_CONFIG), false);

// #983: each failure names the argument at fault by its role, and nothing of its value.
const SHA = 'a'.repeat(40);
const assertArgumentError = (call, argument, message) =>
  assert.throws(call, (error) => {
    assert.ok(error instanceof ArgumentError, `${message}: an ArgumentError`);
    assert.strictEqual(error.argument, argument, message);
    assert.strictEqual(error.message, message);
    return true;
  });
const NOT_A_SHA = '<base sha> is not a full 40-character commit sha';
assertArgumentError(() => anyPathMatches(['a'], '('), 'pattern', '<pattern> is not a regular expression');
assertArgumentError(() => listChangedPaths('HEAD^1', 'HEAD'), 'base sha', NOT_A_SHA);
assertArgumentError(() => listChangedPaths('--output=/tmp/x', SHA), 'base sha', NOT_A_SHA);
assertArgumentError(() => listChangedPaths('A'.repeat(40), SHA), 'base sha', NOT_A_SHA);
assertArgumentError(() => listChangedPaths(undefined, SHA), 'base sha', NOT_A_SHA);
for (const head of [`${SHA}\n`, 'HEAD', '', undefined]) {
  assertArgumentError(
    () => listChangedPaths(SHA, head),
    'head sha',
    '<head sha> is not a full 40-character commit sha',
  );
}

// --- Against real git, in a scratch repository isolated from the machine's git config. ---
const tmp = mkdtempSync(path.join(tmpdir(), 'changed-paths-'));
const repo = path.join(tmp, 'repo');
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(tmp, 'no-global-config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim();
const write = (relative, content = 'x\n') => {
  const file = path.join(repo, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
/** Commits the working tree and returns the new commit's sha. */
const commit = (message) => {
  git('add', '--all');
  git('commit', '--quiet', '--message', message);
  return git('rev-parse', 'HEAD');
};
const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env: gitEnv, encoding: 'utf8' });
const assertAnswer = (base, head, pattern, expected, label) => {
  const result = run(base, head, pattern);
  assert.strictEqual(result.status, 0, `${label}: ${result.stderr}`);
  assert.strictEqual(result.stdout, `${expected}\n`, label);
};

try {
  mkdirSync(repo);
  git('init', '--quiet');
  write('apps/runner/src/moved.ts', 'export const a = 1;\n'.repeat(20));
  write('docs/readme.md');
  const base = commit('base');

  // Nothing in scope changed.
  write('docs/readme.md', 'changed\n');
  const docsOnly = commit('docs only');
  assertAnswer(base, docsOnly, RUNNER, false, 'a docs-only change is out of scope');
  assertAnswer(base, docsOnly, ROOT_CONFIG, false, 'a docs-only change is not root config');
  assertAnswer(base, base, RUNNER, false, 'no change at all');

  // PR #963: a rename out of scope lists only the new path without --no-renames.
  renameSync(path.join(repo, 'apps/runner/src/moved.ts'), path.join(repo, 'docs/moved.ts'));
  const renamedOut = commit('rename out of apps/runner');
  assert.strictEqual(git('diff', '--name-only', docsOnly, renamedOut), 'docs/moved.ts');
  assert.deepStrictEqual(listChangedPaths(docsOnly, renamedOut, repo).sort(), [
    'apps/runner/src/moved.ts',
    'docs/moved.ts',
  ]);
  assertAnswer(docsOnly, renamedOut, RUNNER, true, 'a rename out of apps/runner is in scope');

  // #973: git C-quotes each of these in a plain listing, so `^apps/runner/` never matched them.
  const awkward = [
    'apps/runner/quo"te.ts',
    'apps/runner/back\\slash.ts',
    'apps/runner/tab\there.ts',
    'apps/runner/line\nbreak.ts',
    'apps/runner/café.ts',
  ];
  let previous = renamedOut;
  for (const file of awkward) {
    write(file);
    const next = commit(`add ${JSON.stringify(file)}`);
    const plain = execFileSync('git', ['diff', '--name-only', previous, next], { cwd: repo, env: gitEnv });
    assert.strictEqual(plain.toString('latin1').startsWith('"'), true, `git quotes ${JSON.stringify(file)}`);
    assert.deepStrictEqual(
      listChangedPaths(previous, next, repo),
      [Buffer.from(file, 'utf8').toString('latin1')],
      `verbatim path for ${JSON.stringify(file)}`,
    );
    assertAnswer(previous, next, RUNNER, true, `${JSON.stringify(file)} is in scope`);
    previous = next;
  }

  // A line break in a name must not forge an in-scope path, nor a root-config one.
  write('docs/x\napps/runner/forged.ts');
  write('docs/y\npackage.json');
  const forged = commit('names that embed an in-scope path after a line break');
  assertAnswer(previous, forged, RUNNER, false, 'an embedded apps/runner/ line is not in scope');
  assertAnswer(previous, forged, ROOT_CONFIG, false, 'an embedded package.json line is not root config');

  write('.github/workflows/ci.yml');
  const workflow = commit('workflow');
  assertAnswer(forged, workflow, ROOT_CONFIG, true, 'a workflow change is root config');
  assertAnswer(forged, workflow, RUNNER, true, 'ci.yml is in the sweep scope');

  write('libs/shared/plain-text/src/index.ts');
  const plainText = commit('plain-text');
  assertAnswer(workflow, plainText, RUNNER, true, '@shared/plain-text reaches the sweep through contracts');
  assertAnswer(workflow, plainText, ROOT_CONFIG, false, 'a lib is not root config');

  // --- Fails closed: non-zero and an empty stdout, so `$(…)` under `set -e` stops the step. ---
  const assertFails = (status, label, ...args) => {
    const result = run(...args);
    assert.strictEqual(result.status, status, label);
    assert.strictEqual(result.stdout, '', label);
    return result;
  };
  // #983: the whole of stderr is checked, so the argument is named and nothing else is said.
  const USAGE = 'usage: changed-paths.mjs <base sha> <head sha> <pattern>\n';
  const assertUsage = (problem, label, ...args) =>
    assert.strictEqual(assertFails(2, label, ...args).stderr, `changed-paths: ${problem}\n${USAGE}`, label);
  assertUsage('<base sha> is missing', 'no arguments');
  assertUsage('<head sha> is missing', 'no head', base);
  assertUsage('<pattern> is missing', 'no pattern', base, forged);
  assertUsage('<pattern> is empty', 'an empty pattern', base, forged, '');
  assertUsage(
    '1 unexpected extra argument(s) after <pattern>',
    'an extra argument',
    base,
    forged,
    RUNNER,
    'x',
  );

  const assertError = (reason, label, ...args) =>
    assert.strictEqual(
      assertFails(1, label, ...args)
        .stderr.split('\n')
        .slice(-2)
        .join('\n'),
      `::error::changed-paths: ${reason}. See #973.\n`,
      label,
    );
  const BAD_BASE = '<base sha> is not a full 40-character commit sha';
  const BAD_HEAD = '<head sha> is not a full 40-character commit sha';
  assertError(BAD_BASE, 'a ref name instead of the base sha', 'HEAD~1', forged, RUNNER);
  assertError(BAD_BASE, 'an option instead of the base sha', '--no-index', forged, RUNNER);
  assertError(BAD_HEAD, 'a ref name instead of the head sha', base, 'HEAD', RUNNER);
  // What "Select projects" passes when nx-set-shas exported no NX_HEAD.
  assertError(BAD_HEAD, 'an empty head sha', base, '', RUNNER);
  assertError('<pattern> is not a regular expression', 'a broken pattern', base, forged, '(');
  // git's own complaint is above the annotation; the annotation itself stays constant.
  assertError(
    'git could not list the paths changed between <base sha> and <head sha>',
    'a commit that does not exist',
    'f'.repeat(40),
    forged,
    RUNNER,
  );
  // The failure line never echoes an argument into a workflow command: with nothing from git above it, the
  // annotation is all of stderr.
  const hostile = assertFails(1, 'a hostile argument', '\n::warning::injected', forged, '(\n::add-mask::x');
  assert.strictEqual(hostile.stderr, `::error::changed-paths: ${BAD_BASE}. See #973.\n`);
  const hostilePattern = assertFails(1, 'a hostile pattern', base, forged, '(\n::add-mask::x%0A::error::y');
  assert.strictEqual(
    hostilePattern.stderr,
    '::error::changed-paths: <pattern> is not a regular expression. See #973.\n',
  );

  // #983: a path that differs from the pattern only in case is in scope, through real git too.
  // No `redaction` directory exists yet, so the name keeps its capitals on a case-insensitive volume too.
  write('libs/shared/Redaction/src/Upper.ts');
  const upperCase = commit('mixed-case twin of libs/shared/redaction');
  assert.deepStrictEqual(listChangedPaths(plainText, upperCase, repo), [
    'libs/shared/Redaction/src/Upper.ts',
  ]);
  assertAnswer(plainText, upperCase, RUNNER, true, 'Redaction/ is redaction/ on a case-insensitive volume');
  write('tools/ci/changed-paths.mjs');
  const scopingScript = commit('the scoping script');
  assertAnswer(upperCase, scopingScript, ROOT_CONFIG, true, 'the scoping script is root config');
  assertAnswer(upperCase, scopingScript, RUNNER, true, 'the scoping script is in the sweep scope');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write(
  'ok: changed-paths matches quoted, renamed, multi-line and mixed-case paths whole and fails closed\n',
);
