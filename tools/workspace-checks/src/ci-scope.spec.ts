import { workspaceRoot } from '@nx/devkit';
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
}

const ci = parse(readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
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
const runOf = (job: string, predicate: (step: Step) => boolean): string =>
  ci.jobs[job]?.steps?.find(predicate)?.run ?? '';

const selectProjects = runOf('lint-test-build', (step) => step.name === 'Select projects');
const darwinScope = runOf('runner-darwin-scope', (step) => step.id === 'scope');
const sweep = runOf('runner-darwin-sweep', (step) => step.run?.includes('vitest run') === true);

/** The single-quoted pattern a script assigns to `name`, as the regular expression changed-paths.mjs builds. */
function patternOf(script: string, name: string): RegExp {
  const source = new RegExp(`^\\s*${name}='([^']+)'$`, 'm').exec(script)?.[1];
  if (source === undefined) {
    throw new Error(`no ${name}='…' assignment in the step`);
  }
  return new RegExp(source);
}

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
