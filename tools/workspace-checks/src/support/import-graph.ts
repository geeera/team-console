import { workspaceRoot } from '@nx/devkit';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * The import walk the workspace checks share (hooks-isolation.spec.ts, ci-scope.spec.ts): which workspace files a
 * source file pulls in, following relative imports and the `tsconfig.base.json` aliases.
 */

interface TsconfigBase {
  readonly compilerOptions: { readonly paths: Readonly<Record<string, readonly string[]>> };
}

const ALIASES: Readonly<Record<string, readonly string[]>> = (
  JSON.parse(readFileSync(join(workspaceRoot, 'tsconfig.base.json'), 'utf8')) as TsconfigBase
).compilerOptions.paths;

/** The workspace file a specifier names, or `null` for a package outside the workspace. */
function resolved(from: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    const base = join(dirname(join(workspaceRoot, from)), specifier);
    // A `.json` import is a leaf: it is data, it imports nothing.
    const candidate = [`${base}.ts`, join(base, 'index.ts'), base].find(
      (path) => existsSync(path) && statSync(path).isFile(),
    );
    if (candidate === undefined) {
      throw new Error(`${from}: cannot resolve ${specifier}`);
    }
    return relative(workspaceRoot, candidate);
  }
  const target = ALIASES[specifier]?.[0];
  return target === undefined ? null : relative(workspaceRoot, join(workspaceRoot, target));
}

/** Every workspace file reachable from `entry` through static, type-only, re-export and dynamic imports. */
export function reachableFrom(entry: string): Map<string, string> {
  const reachedFrom = new Map<string, string>([[entry, entry]]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!file.endsWith('.ts')) {
      continue;
    }
    const source = readFileSync(join(workspaceRoot, file), 'utf8');
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const target = resolved(file, imported.fileName);
      if (target !== null && !reachedFrom.has(target)) {
        reachedFrom.set(target, file);
        queue.push(target);
      }
    }
  }
  return reachedFrom;
}
