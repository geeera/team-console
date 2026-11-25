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
  it('lets a test shard end without running a test only in an affected run', () => {
    const lines = withoutComments(testShard)
      .split('\n')
      .map((line) => line.trim());
    const emptyAt = lines.indexOf('if [ -z "${projects}" ]; then');
    const skipAt = lines.indexOf('exit 0');
    expect(emptyAt).toBeGreaterThan(-1);
    expect(lines.filter((line) => line === 'exit 0')).toHaveLength(1);
    // The full-run failure sits between "the shard is empty" and the only `exit 0`.
    expect(lines.slice(emptyAt + 1, skipAt).slice(0, 4)).toEqual([
      'if [ "${NX_MODE}" != "affected" ]; then',
      'echo "::error title=Test shard ${SHARD}::a full run gave this shard no project to test"',
      'exit 1',
      'fi',
    ]);
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
});
