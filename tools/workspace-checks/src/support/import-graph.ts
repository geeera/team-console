import { workspaceRoot } from '@nx/devkit';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * The import walk the workspace checks share (hooks-isolation.spec.ts, ci-scope.spec.ts): which workspace files a
 * source file pulls in, following relative imports and the `tsconfig.base.json` aliases.
 */

export type Aliases = Readonly<Record<string, readonly string[]>>;

/** Where the walk runs: the real workspace by default, a scratch one in import-graph.spec.ts. */
export interface Workspace {
  readonly root: string;
  readonly aliases: Aliases;
}

interface TsconfigBase {
  readonly compilerOptions: { readonly paths: Aliases };
}

const WORKSPACE: Workspace = {
  root: workspaceRoot,
  aliases: (JSON.parse(readFileSync(join(workspaceRoot, 'tsconfig.base.json'), 'utf8')) as TsconfigBase)
    .compilerOptions.paths,
};

/**
 * The targets tsconfig `paths` gives a specifier, or `null` when no key matches. TypeScript's own order: an exact
 * key wins, then the wildcard key with the longest prefix; the text `*` stood for replaces `*` in each target
 * (#983: only exact keys were read, so an import through a wildcard alias dropped out of the walk unseen).
 */
export function aliasTargets(aliases: Aliases, specifier: string): readonly string[] | null {
  if (Object.hasOwn(aliases, specifier)) {
    return aliases[specifier] ?? null;
  }
  let best: { readonly prefix: string; readonly suffix: string; readonly targets: readonly string[] } | null =
    null;
  for (const [key, targets] of Object.entries(aliases)) {
    const star = key.indexOf('*');
    if (star === -1) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    const isMatch =
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix);
    if (isMatch && (best === null || prefix.length > best.prefix.length)) {
      best = { prefix, suffix, targets };
    }
  }
  if (best === null) {
    return null;
  }
  const matched = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
  // A function replacement: `$&` and the like in the matched text stay literal.
  return best.targets.map((target) => target.replace('*', () => matched));
}

/** The file `base` names as an import target (itself, `.ts` added, or its `index.ts`), if there is one. */
function existingFile(base: string): string | undefined {
  // A `.json` import is a leaf: it is data, it imports nothing.
  return [`${base}.ts`, join(base, 'index.ts'), base].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
}

/** The workspace file a specifier names, or `null` for a package outside the workspace. */
function resolved(workspace: Workspace, from: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    const candidate = existingFile(join(dirname(join(workspace.root, from)), specifier));
    if (candidate === undefined) {
      throw new Error(`${from}: cannot resolve ${specifier}`);
    }
    return relative(workspace.root, candidate);
  }
  const targets = aliasTargets(workspace.aliases, specifier);
  if (targets === null) {
    return null;
  }
  // The first target that exists, as the compiler picks it. An alias that matches and leads nowhere is an
  // error, not "outside the workspace": skipping it would hide whatever the import really pulls in.
  for (const target of targets) {
    const candidate = existingFile(join(workspace.root, target));
    if (candidate !== undefined) {
      return relative(workspace.root, candidate);
    }
  }
  throw new Error(`${from}: alias ${specifier} matches tsconfig paths but none of its targets exists`);
}

/** Every workspace file reachable from `entry` through static, type-only, re-export and dynamic imports. */
export function reachableFrom(entry: string, workspace: Workspace = WORKSPACE): Map<string, string> {
  const reachedFrom = new Map<string, string>([[entry, entry]]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!file.endsWith('.ts')) {
      continue;
    }
    const source = readFileSync(join(workspace.root, file), 'utf8');
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const target = resolved(workspace, file, imported.fileName);
      if (target !== null && !reachedFrom.has(target)) {
        reachedFrom.set(target, file);
        queue.push(target);
      }
    }
  }
  return reachedFrom;
}
