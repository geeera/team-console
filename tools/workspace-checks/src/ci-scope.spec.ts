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

/** Where the `if` that opens at `openAt` closes, or -1. */
function closingFi(lines: readonly string[], openAt: number): number {
  let depth = 0;
  for (let at = openAt; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (/^if\b/.test(line)) depth += 1;
    if (/^fi\b/.test(line)) depth -= 1;
    if (depth === 0) return at;
  }
  return -1;
}

const SUCCESS_EXIT = /\bexit 0\b/;
const FAILING_EXIT = /^exit [1-9][0-9]*$/;
const EMPTY_SHARD = /^if \[\[? -z "?\$\{?projects\}?"? \]\]?; then$/;
const BRANCH = /^(else|elif)\b/;
const NOT_AFFECTED = /^if \[\[? "?\$\{?NX_MODE\}?"? != ["']?affected["']? \]\]?; then$/;

/**
 * What is wrong with how the "Test" step treats a shard that has no project (#999), as text; empty when the
 * step may end green without a test only in an affected run. The rule, whatever the lines look like (#1005):
 * the one `exit 0` of the script is inside `if [ -z "${projects}" ]`, and before it that block holds a closed
 * `if [ "${NX_MODE}" != "affected" ]` that exits non-zero on its top level; the tests run after the block.
 */
function emptyShardProblems(script: string): readonly string[] {
  const lines = commandsOf(script);
  const emptyAt = lines.findIndex((line) => EMPTY_SHARD.test(line));
  const emptyEnd = emptyAt === -1 ? -1 : closingFi(lines, emptyAt);
  if (emptyEnd === -1) {
    return ['no closed `if [ -z "${projects}" ]` block'];
  }
  const problems: string[] = [];
  const successes = lines.flatMap((line, at) => (SUCCESS_EXIT.test(line) ? [at] : []));
  const skipAt = successes[0] ?? -1;
  if (successes.length !== 1 || lines[skipAt] !== 'exit 0' || skipAt < emptyAt || skipAt > emptyEnd) {
    problems.push('`exit 0` is not one plain line inside the empty-shard block');
  }
  // An `else` would put what follows it on the side of a shard that has projects.
  if (lines.slice(emptyAt, emptyEnd).some((line) => BRANCH.test(line))) {
    problems.push('the empty-shard block has an else branch');
  }
  const guardAt = lines.findIndex((line, at) => at > emptyAt && at < emptyEnd && NOT_AFFECTED.test(line));
  const guardEnd = guardAt === -1 ? -1 : closingFi(lines, guardAt);
  if (guardEnd === -1 || guardEnd > skipAt) {
    problems.push('no closed full-run guard before the `exit 0`');
  } else {
    // Directly in the guard, not in a block of its own or behind `&&`: nothing in the way of the failure.
    const body = lines.slice(guardAt + 1, guardEnd);
    const nestedAt = body.findIndex((line) => /^(if|for|while|case|until)\b/.test(line));
    const top = nestedAt === -1 ? body : body.slice(0, nestedAt);
    if (!top.some((line) => FAILING_EXIT.test(line))) {
      problems.push('the full-run guard does not exit non-zero');
    }
  }
  const runAt = lines.findIndex((line) => /\bnx run-many\b.*-t test\b/.test(line));
  if (runAt !== -1 && runAt < emptyEnd) {
    problems.push('the tests run before the empty shard is handled');
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

  it.each([
    ['Select projects', selectProjects, 1],
    ['the Darwin sweep scope', darwinScope, 2],
    ['the root image scope', imageScope, 2],
  ])(
    'asks the matcher in %s as a plain assignment, so a failing script stops the step',
    (_, script, calls) => {
      expect(script).toMatch(/^set -euo pipefail$/m);
      const lines = matcherCalls(script);
      expect(lines).toHaveLength(calls);
      for (const line of lines) {
        // `x=$(node … "${a}" "${b}" "${pattern}")` and nothing else: no `if`, `[`, `||`, `&&` or pipe around it.
        expect(line.trim()).toMatch(
          /^[a-z_]+=\$\(node tools\/ci\/changed-paths\.mjs "\$\{[A-Za-z_:-]+\}" "\$\{[A-Za-z_:-]+\}" "\$\{[a-z_]+\}"\)$/,
        );
      }
      expect(script).not.toContain('${{');
    },
  );

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
    const check = withoutComments(aggregator?.steps?.[0]?.run ?? '');
    expect(aggregator?.steps).toHaveLength(1);
    expect(check).toMatch(/^set -euo pipefail$/m);
    expect(check).toContain(
      'if [ "${SCOPE_RESULT}" != "success" ] || [ "${SHARD_RESULT}" != "success" ]; then',
    );
    expect(check).toMatch(/^\s*exit 1$/m);
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
    const lines = withoutComments(testShard)
      .split('\n')
      .map((line) => line.trim());
    expect(lines.filter((line) => line.includes('nx show projects'))).toEqual([
      'listed=$(npx nx show projects --affected --base="${NX_BASE}" --head="${NX_HEAD}" --with-target test --json)',
      'listed=$(npx nx show projects --with-target test --json)',
    ]);
    // workspace-checks whatever the scope (#71), and the same `--always`/`--weights` in every shard. `--scope`
    // (#999) is what lets the script tell a full run that lists nothing from an affected run with nothing to do.
    expect(lines.filter((line) => line.includes('shard-projects.mjs'))).toEqual([
      'projects=$(node tools/ci/shard-projects.mjs "${SHARD}" --scope "${NX_MODE}" --always workspace-checks --weights "${TEST_WEIGHTS}" <<<"${listed}")',
    ]);
    expect(lines).toContain('npx nx run-many -t test --projects="${projects}"');
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
      ['the empty-shard check is gone', () => reworded(/^if \[ -z(?:.*\n)*?fi\n/m, '')],
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
