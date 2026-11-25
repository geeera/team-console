import { createProjectGraphAsync, workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { reachableFrom } from './support/import-graph';

/**
 * #973 (SECURITY notes on PR #963): ci.yml decides two scopes from the changed paths — every project or only the
 * affected ones ("Select projects"), and whether the macOS sweep runs at all. A decision that misses a path
 * skips checks silently, so both go through tools/ci/changed-paths.mjs (NUL-separated, renames split; its own
 * fixtures are tools/ci/changed-paths.test.mjs) and the sweep's pattern covers everything the sweep's spec imports.
 */

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly steps?: readonly Step[];
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly strategy?: {
    readonly matrix?: { readonly include?: readonly Readonly<Record<string, string>>[] };
  };
}

const ci = parse(readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  readonly jobs: Readonly<Record<string, Job>>;
};
/** A step's script without its comment lines, which may quote the commands this file forbids. */
const withoutComments = (script: string): string =>
  script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
const allRuns = Object.values(ci.jobs).flatMap((job) =>
  (job.steps ?? []).map((step) => withoutComments(step.run ?? '')),
);
const stepsOf = (job: string): readonly Step[] => ci.jobs[job]?.steps ?? [];
const runOf = (job: string, predicate: (step: Step) => boolean): string =>
  stepsOf(job).find(predicate)?.run ?? '';

const selectProjects = runOf('lint-test-build-scope', (step) => step.name === 'Select projects');
const testShard = runOf('lint-test-build-shard', (step) => step.name?.startsWith('Test (') === true);
const darwinScope = runOf('runner-darwin-scope', (step) => step.id === 'scope');
const sweep = runOf('runner-darwin-sweep', (step) => step.run?.includes('vitest run') === true);
const imageScope = runOf('runtime-image-scope', (step) => step.id === 'scope');

/**
 * The single-quoted pattern a script assigns to `name`, as the regular expression changed-paths.mjs builds:
 * no `m` flag, and case ignored (#983; tools/ci/changed-paths.test.mjs holds the script itself to that).
 */
function patternOf(script: string, name: string): RegExp {
  const source = new RegExp(`^\\s*${name}='([^']+)'$`, 'm').exec(script)?.[1];
  if (source === undefined) {
    throw new Error(`no ${name}='…' assignment in the step`);
  }
  return new RegExp(source, 'i');
}

/** The repository scripts a step runs with `node`. */
const nodeScripts = (script: string): readonly string[] =>
  [...withoutComments(script).matchAll(/\bnode (tools\/[\w./-]+)/g)].flatMap((match) => match[1] ?? []);

/** The lines of a script that call the matcher. */
const matcherCalls = (script: string): readonly string[] =>
  withoutComments(script)
    .split('\n')
    .filter((line) => line.includes('changed-paths.mjs'));

/** The commands of a script: no comment or blank lines, no indentation, `then` on the line of its `if`. */
const commandsOf = (script: string): readonly string[] =>
  withoutComments(script)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reduce<string[]>(
      (lines, line) =>
        line === 'then' && lines.length > 0
          ? [...lines.slice(0, -1), `${lines.at(-1) ?? ''}; then`]
          : [...lines, line],
      [],
    );

const OPENS_BLOCK = /^(if|for|while|until|case|select)\b|[{(]$|^\(/;
const CLOSES_BLOCK = /^(fi|done|esac)\b|^[})]/;
const CLOSED_ON_ITS_LINE = /;\s*(fi|done|esac)$/;

/** How many blocks each line is inside of; a line that opens or closes a block counts as outside it. */
function depthsOf(lines: readonly string[]): readonly number[] {
  let depth = 0;
  return lines.map((line) => {
    if (CLOSES_BLOCK.test(line)) depth -= 1;
    const own = depth;
    if (OPENS_BLOCK.test(line) && !CLOSED_ON_ITS_LINE.test(line)) depth += 1;
    return own;
  });
}

/** Where the `if` that opens at `openAt` closes, or -1. */
const closingFi = (lines: readonly string[], depths: readonly number[], openAt: number): number =>
  lines.findIndex((line, at) => at > openAt && line === 'fi' && depths[at] === depths[openAt]);

const FAILING_EXIT = /^exit [1-9][0-9]*$/;
const EMPTY_SHARD = /^if \[\[? -z "?\$\{?projects\}?"? \]\]?; then$/;
const NOT_AFFECTED = /^if \[\[? "?\$\{?NX_MODE\}?"? != ["']?affected["']? \]\]?; then$/;
/** `echo` of one double-quoted string that expands nothing but plain `${NAME}`: it can only print. */
const MESSAGE = /^echo "(?:[^"`$\\]|\$\{[A-Za-z_]+\})*"$/;
const SHARD_CALL = /^projects=\$\(node tools\/ci\/shard-projects\.mjs [^()`;&|]*\)$/;
const RUNS_TESTS = /\bnx run-many\b.*-t test\b/;
/** The test run on its own: no `||`, `&&`, `;`, `!`, pipe, redirect or substitution that could hide its status. */
const PLAIN_TEST_RUN = /^npx nx run-many (?:[^;&|<>()`$\\!]|\$\{[A-Za-z_]+\})*$/;
/** Any `set` that turns an option off (`set +e`, `set +o errexit`, `set -u +e`), read with the quotes removed. */
const UNSETS_AN_OPTION = /\bset\b[^;&|]*\s\+[A-Za-z]/;
/** A function or an alias: either can stand in for `npx`, `node` or `exit`. */
const DEFINES_A_COMMAND = /^function\b|^[\w-]+\s*\(\s*\)|\balias\b/;
/** Anything that ends the script, or may: `exit` in every spelling, `exec`, `return`, a trap. */
const LEAVES = /\b(exit|exec|return|trap)\b/;
/** Anything that can give NX_MODE or `projects` another value, read with the quotes and backslashes removed. */
const SETS_A_DECISION = new RegExp(
  [
    '(^|[\\s;&|({])(NX_MODE|projects)(\\[[^\\]]*\\])?\\+?=',
    '\\$\\{(NX_MODE|projects):?=',
    '\\b(read|unset|declare|typeset|local|export|readonly|mapfile|readarray|let|getopts|for|select|printf)\\b.*\\b(NX_MODE|projects)\\b',
    '\\b(eval|source)\\b|^\\. ',
  ].join('|'),
);

/**
 * What is wrong with how the "Test" step treats a shard that has no project (#999), as text; empty when the
 * step may end green without a test only in an affected run. The rule, however the lines are laid out (#1005):
 *
 *   projects=$(node tools/ci/shard-projects.mjs …)      once, at the top level
 *   if [ -z "${projects}" ]; then                       once, at the top level, after it
 *     if [ "${NX_MODE}" != "affected" ]; then           the first command of the block
 *       echo "…"                                        messages only
 *       exit <non-zero>                                 the last command of the guard
 *     fi
 *     echo "…"                                          messages only
 *     exit 0                                            the last command of the block
 *   fi
 *   npx nx run-many -t test …                           once, on its own, the last command of the script
 *
 * and nowhere else does the script leave (`exit`, `exec`, `return`, `trap`) or set NX_MODE or `projects`.
 * #1013: the first command is `set -euo pipefail`, no later `set` turns an option off, and nothing is defined
 * that could stand in for a command — `set +e` before the tests and `true` after them ended green on red tests.
 * Anything it cannot read as this is a problem: the rule fails closed.
 */
function emptyShardProblems(script: string): readonly string[] {
  const lines = commandsOf(script);
  const depths = depthsOf(lines);
  const indexesOf = (pattern: RegExp): readonly number[] =>
    lines.flatMap((line, at) => (pattern.test(line) ? [at] : []));
  const onlyMessages = (from: number, to: number): boolean =>
    lines.slice(from, to).every((line) => MESSAGE.test(line));

  const calls = indexesOf(SHARD_CALL);
  const blocks = indexesOf(EMPTY_SHARD);
  const callAt = calls[0] ?? -1;
  const emptyAt = blocks[0] ?? -1;
  if (calls.length !== 1 || depths[callAt] !== 0) {
    return ['`projects=$(node tools/ci/shard-projects.mjs …)` is not there once, at the top level'];
  }
  const emptyEnd = emptyAt === -1 ? -1 : closingFi(lines, depths, emptyAt);
  if (blocks.length !== 1 || depths[emptyAt] !== 0 || emptyAt < callAt || emptyEnd === -1) {
    return ['`if [ -z "${projects}" ]` is not one closed block at the top level, after the shard is taken'];
  }

  const problems: string[] = [];
  if (lines[0] !== 'set -euo pipefail') {
    problems.push('`set -euo pipefail` is not the first command');
  }
  const guardAt = emptyAt + 1;
  const guardEnd = NOT_AFFECTED.test(lines[guardAt] ?? '') ? closingFi(lines, depths, guardAt) : -1;
  const failAt = guardEnd - 1;
  const skipAt = emptyEnd - 1;
  if (guardEnd === -1 || guardEnd > emptyEnd) {
    problems.push('the full-run guard is not the first command of the empty-shard block');
  } else {
    if (!FAILING_EXIT.test(lines[failAt] ?? '') || !onlyMessages(guardAt + 1, failAt)) {
      problems.push('the full-run guard is not messages and then `exit <non-zero>` as its last command');
    }
    if (lines[skipAt] !== 'exit 0' || !onlyMessages(guardEnd + 1, skipAt)) {
      problems.push('after the guard the block is not messages and then `exit 0` as its last command');
    }
  }

  lines.forEach((line, at) => {
    if (MESSAGE.test(line)) return;
    const bare = line.replace(/["'\\]/g, '');
    if (LEAVES.test(bare) && at !== failAt && at !== skipAt) {
      problems.push(`the script may leave outside the empty-shard block: ${line}`);
    }
    if (SETS_A_DECISION.test(bare) && at !== callAt) {
      problems.push(`NX_MODE or \`projects\` may be set again: ${line}`);
    }
    if (UNSETS_AN_OPTION.test(bare)) {
      problems.push(`a shell option is turned off: ${line}`);
    }
    if (DEFINES_A_COMMAND.test(bare)) {
      problems.push(`a function or an alias is defined: ${line}`);
    }
  });

  const runs = indexesOf(RUNS_TESTS);
  const runAt = runs[0] ?? -1;
  if (runs.length !== 1 || runAt < emptyEnd || depths[runAt] !== 0) {
    problems.push('the tests do not run once, at the top level after the empty-shard block');
  } else if (runAt !== lines.length - 1 || !PLAIN_TEST_RUN.test(lines[runAt] ?? '')) {
    // The status of the last command is the status of the step: nothing may follow or wrap the test run.
    problems.push('the test run is not the last command of the script, on its own');
  }
  return problems;
}

describe('ci.yml scope decisions', () => {
  it('never lists changed paths with a line-based git command', () => {
    const lineBased = allRuns.filter((run) =>
      /\bgit\b[^\n|;&]*\b(diff|diff-tree|log|show|status|ls-files)\b[^\n]*--name-(only|status)/.test(run),
    );
    expect(lineBased).toEqual([]);
    expect(allRuns.filter((run) => /grep[^\n]*<<<\s*"\$\{changed\}"/.test(run))).toEqual([]);
  });

  it('asks the matcher in Select projects as a plain assignment, so a failing script stops the step', () => {
    expect(selectProjects).toMatch(/^set -euo pipefail$/m);
    const lines = matcherCalls(selectProjects);
    expect(lines).toHaveLength(1);
    // `x=$(node … "${a}" "${b}" "${pattern}")` and nothing else: no `if`, `[`, `||`, `&&` or pipe around it.
    expect(lines[0]?.trim()).toMatch(
      /^[a-z_]+=\$\(node tools\/ci\/changed-paths\.mjs "\$\{[A-Za-z_:-]+\}" "\$\{[A-Za-z_:-]+\}" "\$\{[a-z_]+\}"\)$/,
    );
    expect(selectProjects).not.toContain('${{');
  });

  // #1005: the two scope jobs repeated one bash decision. It is `changed-paths.mjs --event-scope` now (held to
  // the old steps' answers by tools/ci/changed-paths.test.mjs), and each step is the same six commands around
  // its own pattern: anything else in a step would be a second decision next to the shared one.
  describe.each([
    ['runner-darwin-scope', darwinScope],
    ['runtime-image-scope', imageScope],
  ])('the scope step of %s', (job, script) => {
    it('is the shared decision as one plain assignment, checked before it becomes the job output', () => {
      const commands = commandsOf(script);
      expect(commands).toHaveLength(6);
      expect(commands[0]).toBe('set -euo pipefail');
      expect(commands[1]).toMatch(/^paths='[^']+'$/);
      // No `if`, `[`, `||`, `&&` or pipe around it: a failing script stops the step.
      expect(commands[2]).toBe('run=$(node tools/ci/changed-paths.mjs --event-scope "${paths}")');
      // The two messages are held as messages (#1013), whatever they say: only the commands decide.
      expect(commands[3]).toMatch(
        /^\[\[ "\$\{run\}" =~ \^\(true\|false\)\$ \]\] \|\| \{ echo "[^"`$\\]*"; exit [1-9][0-9]*; \}$/,
      );
      expect(commands[4]).toBe('echo "run=${run}" >> "$GITHUB_OUTPUT"');
      expect(commands[5]).toMatch(MESSAGE);
      expect(commands[5]).toContain('${run}');
      expect(matcherCalls(script)).toHaveLength(1);
      expect(script).not.toContain('${{');
    });

    it('hands the script the event through the three variables it reads, and nothing else', () => {
      const step = stepsOf(job).find((candidate) => candidate.id === 'scope');
      expect(step?.env).toEqual({
        EVENT: '${{ github.event_name }}',
        BASE_REF: "${{ github.event_name == 'pull_request' && github.base_ref || github.ref_name }}",
        BEFORE: '${{ github.event.before }}',
      });
      expect(step?.with).toBeUndefined();
      expect(step?.uses).toBeUndefined();
    });

    it('is the job output the next job is gated on, with the history the comparison needs', () => {
      const definition = ci.jobs[job] as Job & { readonly outputs?: Readonly<Record<string, string>> };
      expect(definition.outputs).toEqual({ run: '${{ steps.scope.outputs.run }}' });
      const checkout = stepsOf(job).find((step) => step.uses?.startsWith('actions/checkout@') === true);
      // The merge commit's first parent, or the commit before a push, must be in the clone.
      expect(checkout?.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    });
  });

  it('runs every project when a root file or a workflow changes, renamed away or not', () => {
    const rootConfig = patternOf(selectProjects, 'root_config');
    for (const path of ['.github/workflows/ci.yml', 'package-lock.json', 'tsconfig.base.json', 'nx.json']) {
      expect(rootConfig.test(path), path).toBe(true);
    }
    for (const path of ['apps/api/package.json', 'docs/nx.json.md', 'x\npackage.json', '"package.json"']) {
      expect(rootConfig.test(path), JSON.stringify(path)).toBe(false);
    }
  });

  // #983: no Nx project owns tools/ci/ or .github/actions/, so "affected" saw a change to the script that picks
  // the scope as a change to nothing and ran next to nothing on it.
  it('runs every project when a script that decides a scope, or the composite action, changes', () => {
    const rootConfig = patternOf(selectProjects, 'root_config');
    const paths = patternOf(darwinScope, 'paths');
    const deciders = [...new Set([...nodeScripts(selectProjects), ...nodeScripts(darwinScope)])];
    expect(deciders).toEqual(['tools/ci/changed-paths.mjs']);
    for (const script of deciders) {
      expect(rootConfig.test(script), script).toBe(true);
      expect(paths.test(script), script).toBe(true);
    }
    for (const path of ['tools/ci/changed-paths.test.mjs', '.github/actions/setup-node-npm/action.yml']) {
      expect(rootConfig.test(path), path).toBe(true);
    }
    expect(rootConfig.test('docs/tools/ci/changed-paths.mjs')).toBe(false);
  });

  // #983: the macOS runner's volume ignores case, so `Apps/Runner/x.ts` is a file of apps/runner there.
  it('matches a path that differs from the pattern only in case', () => {
    const rootConfig = patternOf(selectProjects, 'root_config');
    const paths = patternOf(darwinScope, 'paths');
    for (const path of [
      'Apps/Runner/x.ts',
      'libs/Shared/Contracts/src/index.ts',
      '.GITHUB/workflows/CI.yml',
    ]) {
      expect(paths.test(path), path).toBe(true);
    }
    for (const path of ['Package.json', '.github/Workflows/deploy.yml', 'Tools/CI/changed-paths.mjs']) {
      expect(rootConfig.test(path), path).toBe(true);
    }
    expect(paths.test('Docs/Apps/Runner/x.ts')).toBe(false);
  });

  // #983: the scope job ran the script on whatever Node the runner image shipped.
  it.each([
    ['lint-test-build-scope', (step: Step) => step.name === 'Select projects'],
    ['runner-darwin-scope', (step: Step) => step.id === 'scope'],
    ['runtime-image-scope', (step: Step) => step.id === 'scope'],
  ])('pins Node from .nvmrc, by a full commit sha, before the decision in %s', (job, isDecision) => {
    const steps = stepsOf(job);
    const setupNode = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@') === true);
    expect(setupNode).toBeGreaterThan(-1);
    expect(steps[setupNode]?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(steps[setupNode]?.with).toEqual({ 'node-version-file': '.nvmrc', 'package-manager-cache': false });
    expect(setupNode).toBeLessThan(steps.findIndex(isDecision));
  });

  // #992: `lint-test-build` is the check dev's ruleset and `scripts/pr gate` read. It is an aggregator now, so
  // it must run whatever happened to the jobs behind it: a skipped required check counts as passed.
  it('keeps lint-test-build as one check that fails unless the scope job and every shard passed', () => {
    const aggregator = ci.jobs['lint-test-build'];
    expect(aggregator?.needs).toEqual(['lint-test-build-scope', 'lint-test-build-shard']);
    expect(aggregator?.if).toBe('always()');
    expect(aggregator?.steps).toHaveLength(1);
    expect(aggregator?.steps?.[0]?.env).toEqual({
      SCOPE_RESULT: '${{ needs.lint-test-build-scope.result }}',
      SHARD_RESULT: '${{ needs.lint-test-build-shard.result }}',
    });
    // #1013: held as a shape, not as one line. The whole script is one `if` over "some result is not success",
    // with nothing in it but messages and a failing exit as its last command.
    const check = commandsOf(aggregator?.steps?.[0]?.run ?? '');
    const failAt = check.length - 2;
    expect(check[0]).toBe('set -euo pipefail');
    const conditions = (/^if (.+); then$/.exec(check[1] ?? '')?.[1] ?? '').split(' || ');
    const notSuccess = conditions.map(
      (condition) =>
        /^\[\[? "?\$\{?([A-Z_]+)\}?"? != ["']?success["']? \]\]?$/.exec(condition)?.[1] ??
        `unread: ${condition}`,
    );
    expect([...notSuccess].sort()).toEqual(['SCOPE_RESULT', 'SHARD_RESULT']);
    expect(failAt).toBeGreaterThanOrEqual(2);
    for (const message of check.slice(2, failAt)) expect(message).toMatch(MESSAGE);
    expect(check[failAt]).toMatch(FAILING_EXIT);
    expect(check[failAt + 1]).toBe('fi');
  });

  // #992: a matrix that lists 1/3 and 2/3 and forgets 3/3 would be green with a third of the tests never run.
  it('lists every test shard of one split, 1/N to N/N, and one job for the other targets', () => {
    const include = ci.jobs['lint-test-build-shard']?.strategy?.matrix?.include ?? [];
    expect(include.filter((entry) => entry['kind'] === 'static')).toHaveLength(1);
    expect(include.filter((entry) => entry['kind'] !== 'static' && entry['kind'] !== 'test')).toEqual([]);
    const shards = include.filter((entry) => entry['kind'] === 'test').map((entry) => entry['shard']);
    expect(shards.length).toBeGreaterThan(0);
    expect([...shards].sort()).toEqual(shards.map((_, at) => `${at + 1}/${shards.length}`));
    expect(new Set(include.map((entry) => entry['name'])).size).toBe(include.length);
    // Each target still has a step, and only the job of its kind runs it.
    const steps = stepsOf('lint-test-build-shard') as readonly (Step & { readonly if?: string })[];
    for (const target of ['lint', 'typecheck-spec', 'build']) {
      const step = steps.find((candidate) => candidate.run === `npx nx "\${NX_MODE}" -t ${target}`);
      expect(step?.if, target).toBe("matrix.kind == 'static'");
    }
    expect(steps.find((step) => step.name?.startsWith('Test (') === true)?.if).toBe("matrix.kind == 'test'");
  });

  it('takes the project list and the shard as plain assignments, so a failing nx or script stops the step', () => {
    expect(testShard).toMatch(/^set -euo pipefail$/m);
    expect(testShard).not.toContain('${{');
    const lines = commandsOf(testShard);
    // #1013: held by what each command is given, in any order, not as whole lines. `x=$(…)` and nothing around
    // it: no `if`, `||`, `&&`, pipe or second substitution.
    const argumentsOf = (line: string, command: string): readonly string[] => {
      const call = new RegExp(`^[a-z_]+=\\$\\(${command} ([^()\`;&|]*)\\)$`).exec(line)?.[1];
      expect(call, `a plain assignment from \`${command}\`: ${line}`).toBeDefined();
      return (call ?? '').split(/\s+/).filter((word) => word !== '');
    };
    const listings = lines
      .filter((line) => line.includes('nx show projects'))
      .map((line) => [...argumentsOf(line, 'npx nx show projects')].sort());
    expect(lines.filter((line) => line.startsWith('listed='))).toHaveLength(2);
    // The affected listing in the `affected` branch, the full one in its `else`: in that order.
    expect(listings).toEqual([
      ['--affected', '--base="${NX_BASE}"', '--head="${NX_HEAD}"', '--json', '--with-target', 'test'],
      ['--json', '--with-target', 'test'],
    ]);
    const firstListing = lines.findIndex((line) => line.startsWith('listed='));
    expect(lines[firstListing - 1]).toMatch(
      /^if \[\[? "?\$\{?NX_MODE\}?"? ==? ["']?affected["']? \]\]?; then$/,
    );
    expect(lines[firstListing + 1]).toBe('else');
    expect(lines[firstListing + 2]).toMatch(/^listed=/);
    expect(lines[firstListing + 3]).toBe('fi');
    // workspace-checks whatever the scope (#71), and the same `--always`/`--weights` in every shard. `--scope`
    // (#999) is what lets the script tell a full run that lists nothing from an affected run with nothing to do.
    const shardCalls = lines.filter((line) => line.includes('shard-projects.mjs'));
    expect(shardCalls).toHaveLength(1);
    const shard = argumentsOf(shardCalls[0] ?? '', 'node tools/ci/shard-projects.mjs').join(' ');
    expect(shard).toMatch(/^"\$\{SHARD\}" /);
    expect(shard).toMatch(/ <<<"\$\{listed\}"$/);
    for (const option of [
      '--scope "${NX_MODE}"',
      '--always workspace-checks',
      '--weights "${TEST_WEIGHTS}"',
    ]) {
      expect(` ${shard} `, option).toContain(` ${option} `);
    }
    expect(shard.split(' ').filter((word) => word.startsWith('--'))).toHaveLength(3);
    // The shard's own list is what runs; that this is the last command, on its own, is the rule below.
    expect(lines.at(-1)?.split(' ')).toContain('--projects="${projects}"');
    expect(patternOf(selectProjects, 'root_config').test('tools/ci/shard-projects.mjs')).toBe(true);
  });

  // #999: with nothing to run a shard used to end green on a notice, in a full run too.
  // #1005: held as the shape of the script, not as its exact lines. The cases run on a sample, so they keep
  // showing what the rule lets through and what it does not however ci.yml is worded.
  describe('a test shard with nothing to run', () => {
    const SAMPLE = [
      'set -euo pipefail',
      'projects=$(node tools/ci/shard-projects.mjs "${SHARD}" --scope "${NX_MODE}" <<<"${listed}")',
      'if [ -z "${projects}" ]; then',
      '  if [ "${NX_MODE}" != "affected" ]; then',
      '    echo "::error::a full run gave this shard no project to test"',
      '    exit 1',
      '  fi',
      '  echo "::notice::no project with a test target in this shard"',
      '  exit 0',
      'fi',
      'npx nx run-many -t test --projects="${projects}"',
      '',
    ].join('\n');
    const reworded = (from: string | RegExp, to: string): string => {
      const changed = SAMPLE.replace(from, to);
      expect(changed, 'the rewording must change the sample').not.toBe(SAMPLE);
      return changed;
    };
    const GUARD = /^ {2}if \[ "\$\{NX_MODE\}" != "affected" \]; then\n(?:.*\n)*? {2}fi\n/m;
    const TEST_RUN = /^(npx nx run-many.*)\n/m;

    it('ends without running a test only in an affected run', () => {
      expect(testShard).not.toBe('');
      expect(emptyShardProblems(testShard)).toEqual([]);
    });

    it.each([
      ['as it is', () => SAMPLE],
      ['another indentation', () => reworded(/^ +/gm, '\t\t')],
      [
        'another message, and a comment and a blank line in the guard',
        () => reworded(/^ +echo "::error::[^\n]*\n/m, '    # why\n\n    echo "::error title=x::nothing"\n'),
      ],
      [
        'a [[ ]] test',
        () => reworded('if [ "${NX_MODE}" != "affected" ]; then', 'if [[ ${NX_MODE} != affected ]]; then'),
      ],
      ['another failing status', () => reworded('exit 1', 'exit 2')],
      [
        '`then` on its own line',
        () => reworded('if [ -z "${projects}" ]; then', 'if [ -z "${projects}" ]\nthen'),
      ],
      [
        'a notice between the block and the tests',
        () => reworded(TEST_RUN, 'echo "::notice title=Test shard ${SHARD}::${projects}"\n$&'),
      ],
      ['more options on the test run', () => reworded(TEST_RUN, '$1 --parallel=2 --skip-nx-cache\n')],
    ])('accepts the sample step %s', (_, rewrite) => {
      expect(emptyShardProblems(rewrite())).toEqual([]);
    });

    it.each([
      ['the full-run guard is gone', () => reworded(GUARD, '')],
      [
        'the guard is for the affected run instead',
        () => reworded('"${NX_MODE}" != "affected"', '"${NX_MODE}" = "affected"'),
      ],
      [
        'the guard names another variable',
        () => reworded('"${NX_MODE}" != "affected"', '"${SHARD}" != "affected"'),
      ],
      ['the guard only warns', () => reworded('    exit 1\n', '')],
      ['the guard ends in success', () => reworded('exit 1', 'exit 0')],
      ['the failure can be skipped', () => reworded('    exit 1', '    exit 1 || true')],
      [
        'the failure is in the other branch of the guard',
        () => reworded('    exit 1', '    true\n  else\n    exit 1'),
      ],
      [
        'the failure is behind a second condition',
        () => reworded('    exit 1\n', '    if [ "${SHARD}" = "1/2" ]; then\n      exit 1\n    fi\n'),
      ],
      [
        'the skip comes before the guard',
        () =>
          reworded(new RegExp(`(${GUARD.source})( {2}echo "::notice[^\\n]*\\n {2}exit 0\\n)`, 'm'), '$2$1'),
      ],
      [
        'the skip is in an else, for a shard that has projects',
        () => reworded('  exit 0\nfi', '  exit 3\nelse\n  exit 0\nfi'),
      ],
      [
        'there is a second way out in success',
        () => reworded('projects=$(', '[ "${SHARD}" = "2/2" ] && exit 0\nprojects=$('),
      ],
      [
        'the tests run before the empty shard is looked at',
        () => reworded('if [ -z', 'npx nx run-many -t test --projects="${projects}"\nif [ -z'),
      ],
      ['the empty-shard block is never closed', () => reworded(/^fi\n/m, '')],
      // Rework of #1007: each of these passed the first version of the rule and failed the lines it replaced.
      [
        'the guard is inside another condition',
        () => reworded(GUARD, '  if [ "${SHARD}" = "1/2" ]; then\n$&  fi\n'),
      ],
      ['NX_MODE is set in the block before the guard', () => reworded(GUARD, '  NX_MODE=affected\n$&')],
      ['a command comes before the guard', () => reworded(GUARD, '  true\n$&')],
      ['the guard leaves through exec first', () => reworded('    exit 1', '    exec true\n    exit 1')],
      ['the guard fails only in a subshell', () => reworded('    exit 1', '    ( exit 1 )')],
      ['a command follows the failure in the guard', () => reworded('    exit 1', '    exit 1\n    true')],
      [
        'the guard does more than print before it fails',
        () => reworded('    exit 1', '    true\n    exit 1'),
      ],
      ['the guard ends in a bare exit', () => reworded('    exit 1', '    exit')],
      [
        'there is a bare exit elsewhere',
        () => reworded('projects=$(', '[ "${SHARD}" != "2/2" ] || exit\nprojects=$('),
      ],
      [
        'there is a quoted exit 0 elsewhere',
        () => reworded('projects=$(', '[ "${SHARD}" != "2/2" ] || exit "0"\nprojects=$('),
      ],
      ['the skip is a quoted exit 0 with a command after it', () => reworded('  exit 0\n', '  exit "0"\n')],
      ['the script execs away', () => reworded('projects=$(', 'exec true\nprojects=$(')],
      ['a trap ends the script in success', () => reworded('projects=$(', "trap 'exit 0' ERR\nprojects=$(")],
      ['NX_MODE is set at the top', () => reworded('projects=$(', 'NX_MODE=affected\nprojects=$(')],
      ['NX_MODE is set for one command', () => reworded('if [ -z', 'export NX_MODE="affected"\nif [ -z')],
      ['projects is set again', () => reworded('if [ -z', 'projects=all\nif [ -z')],
      ['projects is given a default', () => reworded('if [ -z', ': "${projects:=all}"\nif [ -z')],
      ['projects is read from elsewhere', () => reworded('if [ -z', 'read -r projects <<<"all"\nif [ -z')],
      ['the shard is taken twice', () => reworded(/^(projects=.*\n)/m, '$1$1')],
      ['the shard is not taken by the script', () => reworded(/^projects=.*\n/m, 'projects=$(echo all)\n')],
      [
        'the block is inside a condition that never holds',
        () => reworded(/^if \[ -z(?:.*\n)*?fi\n/m, 'if false; then\n$&fi\n'),
      ],
      [
        'the block is inside a function nobody calls',
        () => reworded(/^if \[ -z(?:.*\n)*?fi\n/m, 'check() {\n$&}\n'),
      ],
      ['the tests run inside a condition', () => reworded(/^npx nx run-many.*\n/m, 'if false; then\n$&fi\n')],
      ['the tests do not run at all', () => reworded(/^npx nx run-many.*\n/m, '')],
      ['the empty-shard check is gone', () => reworded(/^if \[ -z(?:.*\n)*?fi\n/m, '')],
      // #1013: each of these kept the empty-shard path as it was and threw the result of the tests away.
      ['errexit is off and a `true` follows the tests', () => reworded(TEST_RUN, 'set +e\n$1\ntrue\n')],
      ['errexit is turned off before the tests', () => reworded(TEST_RUN, 'set +e\n$&')],
      ['errexit is turned off at the top', () => reworded('projects=$(', 'set +e\nprojects=$(')],
      ['errexit is turned off by its long name', () => reworded(TEST_RUN, 'set +o errexit\n$&')],
      ['every option is turned off at once', () => reworded(TEST_RUN, 'set +euo pipefail\n$&')],
      ['an option is turned off next to one turned on', () => reworded(TEST_RUN, 'set -u +e\n$&')],
      ['errexit is turned off in quotes', () => reworded(TEST_RUN, 'set "+e"\n$&')],
      ['errexit is turned off on the line of another command', () => reworded(TEST_RUN, 'true; set +e\n$&')],
      ['`set -euo pipefail` is gone', () => reworded('set -euo pipefail\n', '')],
      [
        '`set -euo pipefail` comes after the shard is taken',
        () => reworded(/^(set -euo pipefail\n)(projects=.*\n)/m, '$2$1'),
      ],
      ['only errexit is set', () => reworded('set -euo pipefail', 'set -e')],
      ['a command follows the tests', () => reworded(TEST_RUN, '$&true\n')],
      ['a message follows the tests', () => reworded(TEST_RUN, '$&echo "done"\n')],
      ['the test failure is ignored', () => reworded(TEST_RUN, '$1 || true\n')],
      ['the test failure is ignored on the next line', () => reworded(TEST_RUN, '$1 \\\n  || true\n')],
      ['the tests are piped away', () => reworded(TEST_RUN, '$1 | tee test.log\n')],
      ['the tests are followed on their line', () => reworded(TEST_RUN, '$1; true\n')],
      ['the test result is negated', () => reworded(TEST_RUN, '! $1\n')],
      ['the tests run in the background', () => reworded(TEST_RUN, '$1 &\n')],
      ['the tests are the condition of an `if`', () => reworded(TEST_RUN, 'if $1; then\n  true\nfi\n')],
      ['the tests run inside a substitution', () => reworded(TEST_RUN, 'log=$($1)\n')],
      ['the tests run in a subshell', () => reworded(TEST_RUN, '( $1 )\n')],
      ['the tests run twice', () => reworded(TEST_RUN, '$&$&')],
      ['the tests run through another command', () => reworded(TEST_RUN, 'time $1\n')],
      ['npx is a function that does nothing', () => reworded('projects=$(', 'npx() { true; }\nprojects=$(')],
      [
        'npx is a function in the other spelling',
        () => reworded('projects=$(', 'function npx { true; }\nprojects=$('),
      ],
      ['npx is an alias', () => reworded('projects=$(', "alias npx='true'\nprojects=$(")],
    ])('rejects the sample step when %s', (_, rewrite) => {
      expect(emptyShardProblems(rewrite())).not.toEqual([]);
    });
  });

  describe('the projects the test shards name', () => {
    let testProjects: ReadonlySet<string>;
    const shardStep = stepsOf('lint-test-build-shard').find(
      (step) => step.name?.startsWith('Test (') === true,
    );
    const namedBy = (option: string): readonly string[] =>
      [...withoutComments(testShard).matchAll(new RegExp(`${option} ([\\w@./,-]+)`, 'g'))].flatMap((match) =>
        (match[1] ?? '').split(','),
      );

    // The graph, not a glob of config files: `test` comes from the @nx/vitest plugin, and only Nx knows what it
    // infers. Measured for #1005 without the daemon, five runs each: ~1.4 s on an empty Nx cache (2.9 s the
    // first time), ~0.4 s after any `nx` command — which is every CI run — and the same 88 projects each time.
    beforeAll(async () => {
      const graph = await createProjectGraphAsync({ exitOnError: false, resetDaemonClient: true });
      testProjects = new Set(
        Object.values(graph.nodes)
          .filter((node) => Object.hasOwn(node.data.targets ?? {}, 'test'))
          .map((node) => node.name),
      );
    });

    // #999: `--always workspace-checks` is a name in a workflow. Renamed away, `nx run-many --projects=` fails
    // in a full run, but the guard must say why before CI does.
    it('always runs the project tools/workspace-checks/project.json names, which has a test target', () => {
      const project = JSON.parse(
        readFileSync(join(workspaceRoot, 'tools/workspace-checks/project.json'), 'utf8'),
      ) as { readonly name: string };
      expect(namedBy('--always')).toEqual([project.name]);
      expect([...testProjects]).toContain(project.name);
    });

    // #999: TEST_WEIGHTS is kept by hand. A weight for a project that was renamed or lost its tests is ignored
    // by shard-projects.mjs, so the heavy project silently counts 1 and the shards drift apart.
    it('weighs only projects that exist and have a test target', () => {
      const weights = (shardStep?.env?.['TEST_WEIGHTS'] ?? '').split(',').map((entry) => entry.split('='));
      expect(weights.length).toBeGreaterThan(0);
      for (const [name, weight] of weights) {
        expect([...testProjects], `TEST_WEIGHTS names ${name}`).toContain(name);
        expect(weight, `the weight of ${name}`).toMatch(/^[1-9][0-9]{0,4}$/);
      }
      expect(new Set(weights.map(([name]) => name)).size).toBe(weights.length);
    });
  });

  // #992: the shards must split the list the scope job decided on, for the commit it decided on.
  it('hands every shard the one scope decision and checks it before use', () => {
    expect(ci.jobs['lint-test-build-shard']?.needs).toBe('lint-test-build-scope');
    const check = runOf('lint-test-build-shard', (step) => step.name?.startsWith('Check the scope') === true);
    expect(check).toMatch(/^set -euo pipefail$/m);
    expect(check).toContain('[[ "${NX_MODE}" =~ ^(affected|run-many)$ ]]');
    expect(check).toContain('[[ "${NX_BASE}" =~ ^[0-9a-f]{40}$ ]]');
    expect(check).toContain('[ "${checked_out}" = "${NX_HEAD}" ]');
    const steps = stepsOf('lint-test-build-shard');
    const checkAt = steps.findIndex((step) => step.name?.startsWith('Check the scope') === true);
    const firstNx = steps.findIndex((step) => step.run?.includes('npx nx') === true);
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(firstNx);
    // Nothing but the scope job asks nx-set-shas: two askers could get two bases on a push.
    const askers = Object.entries(ci.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => step.uses?.startsWith('nrwl/nx-set-shas@')))
      .map(([name]) => name);
    expect(askers).toEqual(['lint-test-build-scope']);
  });

  it('runs the sweep for the script that makes the decision and for awkward names under apps/runner', () => {
    const paths = patternOf(darwinScope, 'paths');
    for (const path of [
      'tools/ci/changed-paths.mjs',
      '.github/workflows/ci.yml',
      'apps/runner/a"b.ts',
      'apps/runner/a\nb.ts',
      'libs/shared/plain-text/src/index.ts',
    ]) {
      expect(paths.test(path), JSON.stringify(path)).toBe(true);
    }
    for (const path of [
      'docs/x\napps/runner/a.ts',
      'libs/shared/owner-grammar/src/index.ts',
      'apps/api/src/main.ts',
    ]) {
      expect(paths.test(path), JSON.stringify(path)).toBe(false);
    }
  });

  // contracts imports @shared/plain-text, which the pattern did not name (PR #963 review): the pattern has to
  // follow the imports, so this walks them from the one spec file the sweep runs.
  it('covers every workspace file the sweep spec imports, directly or through a library', () => {
    const entry = /vitest run --config (\S+)\/vitest\.config\.mts (\S+)/.exec(sweep);
    expect(entry).not.toBeNull();
    const reached = reachableFrom(`${entry?.[1] ?? ''}/${entry?.[2] ?? ''}`);
    const paths = patternOf(darwinScope, 'paths');

    const missed = [...reached.keys()].filter((file) => !paths.test(file));
    expect(
      missed.map((file) => `${file} (imported by ${reached.get(file) ?? '?'})`),
      'add the library to `paths` in the runner-darwin-scope job',
    ).toEqual([]);
    // The walk does leave apps/runner, so an empty result above is not an empty walk.
    expect(reached.has('libs/shared/contracts/src/index.ts')).toBe(true);
    expect([...reached.keys()].some((file) => file.startsWith('libs/shared/plain-text/'))).toBe(true);
  });

  // #998 (#818.3): the root Dockerfile is built in CI when the change can reach its build context.
  describe('the root image job', () => {
    const paths = patternOf(imageScope, 'paths');
    const imageRuns = stepsOf('runtime-image').map((step) => withoutComments(step.run ?? ''));
    const dockerfile = readFileSync(join(workspaceRoot, 'Dockerfile'), 'utf8');
    const dockerignore = readFileSync(join(workspaceRoot, '.dockerignore'), 'utf8');

    it('runs for the Dockerfile, its ignore file, every file either names and the scripts the job runs', () => {
      const named = [
        // `COPY a b dest` without `--from`: files taken from the build context by name.
        ...[...dockerfile.matchAll(/^COPY (?!--)(.+)$/gm)].flatMap((match) =>
          (match[1] ?? '').split(/\s+/).slice(0, -1),
        ),
        ...[...dockerignore.matchAll(/^!(\S+)$/gm)].flatMap((match) => match[1] ?? []),
        ...imageRuns.flatMap((run) => nodeScripts(run)),
        ...nodeScripts(imageScope),
      ].filter((path) => path !== '.');
      expect(named).toContain('package-lock.json');
      expect(named).toContain('tools/runtime-image/check-runtime-tree.mjs');
      expect(named).toContain('tools/runtime-image/image-files.mjs');
      expect(named).toContain('tools/ci/changed-paths.mjs');
      expect(named.some((path) => path.startsWith('.claude/product-team/'))).toBe(true);
      for (const path of [...named, 'Dockerfile', '.dockerignore', '.github/workflows/ci.yml']) {
        expect(paths.test(path), path).toBe(true);
      }
    });

    it('runs for anything the build inside the image compiles or loads, and not for what cannot reach it', () => {
      for (const path of [
        'apps/api/migrations/0001_init.sql',
        'apps/api/wrangler.jsonc',
        'apps/console/src/main.ts',
        'libs/worker/db/vitest.config.mts',
        'tools/nx-plugins/typecheck-spec.plugin.ts',
        'nx.json',
        'tsconfig.base.json',
        '.nvmrc',
        'DOCKERFILE',
        'Apps/api/src/main.ts',
      ]) {
        expect(paths.test(path), path).toBe(true);
      }
      for (const path of [
        'docs/adr/0001.md',
        'docs/Dockerfile',
        'docs/x\nDockerfile',
        '.product-team/project.yml',
        '.github/workflows/deploy.yml',
        'tools/workspace-checks/src/ci-scope.spec.ts',
        'tools/ci/shard-projects.mjs',
      ]) {
        expect(paths.test(path), JSON.stringify(path)).toBe(false);
      }
    });

    it('builds only when the scope job said exactly true', () => {
      expect(ci.jobs['runtime-image']?.needs).toBe('runtime-image-scope');
      expect(ci.jobs['runtime-image']?.if).toBe("needs.runtime-image-scope.outputs.run == 'true'");
      expect(imageScope).toContain('[[ "${run}" =~ ^(true|false)$ ]]');
    });

    it('builds the Dockerfile as its header says, and the two stages the file list is compared with', () => {
      const builds = imageRuns
        .flatMap((run) => run.split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.startsWith('docker build'));
      expect(builds).toEqual([
        'docker build --tag "${IMAGE}" .',
        'docker build --target runtime-deps --tag "${IMAGE}-runtime-deps" .',
        'docker build --target build --tag "${IMAGE}-build" .',
      ]);
      expect(dockerfile).toMatch(/^FROM deps AS runtime-deps$/m);
      expect(dockerfile).toMatch(/^FROM deps AS build$/m);
    });

    it('checks the file list and waits for healthz, every script stopping on its first failure', () => {
      const scripts = imageRuns.filter((run) => run.trim().includes('\n'));
      expect(scripts.length).toBeGreaterThan(2);
      for (const script of scripts) expect(script).toMatch(/^set -euo pipefail$/m);
      const all = imageRuns.join('\n');
      expect(all).toContain('node tools/runtime-image/image-files.mjs check "${lists}"');
      expect(all).toContain('http://127.0.0.1:8787/api/v1/healthz');
      expect(all).toContain("grep --quiet --fixed-strings 'No migrations to apply'");
      // The listings only read: no network, and the script mounted read-only.
      expect(all).toContain('docker run --rm --network none --user 0 --entrypoint node');
      expect(all).toContain('/image-files.mjs:ro"');
    });

    it('pushes nothing, logs in to nothing, reads no secret and uses only actions pinned by a commit sha', () => {
      const job = JSON.stringify(ci.jobs['runtime-image']) + JSON.stringify(ci.jobs['runtime-image-scope']);
      for (const forbidden of ['docker push', 'docker login', '--push', 'docker tag', 'secrets.', 'buildx']) {
        expect(job, forbidden).not.toContain(forbidden);
      }
      const uses = [...stepsOf('runtime-image'), ...stepsOf('runtime-image-scope')].flatMap(
        (step) => step.uses ?? [],
      );
      expect(uses.length).toBeGreaterThan(0);
      for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    });
  });
});
