import { workspaceRoot } from '@nx/devkit';
import { ESLint } from 'eslint';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * Threat model C6 (#481): the hooks Worker holds no GitHub App credentials, so no module of its bundle may come from
 * `@worker/github` (the app's JWT signing, token minting, the client that carries a token). Since #479 the
 * `@worker/vcs-github` barrel re-exports the adapter and with it `@worker/github`; tree-shaking would probably drop
 * it, but nothing enforced that. Two guards: the hooks ESLint config refuses those imports, and this walk follows
 * every import the Worker's entry reaches, so a library the hooks Worker imports cannot pull it in either.
 */

interface TsconfigBase {
  readonly compilerOptions: { readonly paths: Readonly<Record<string, readonly string[]>> };
}

const ALIASES: Readonly<Record<string, readonly string[]>> = (
  JSON.parse(readFileSync(join(workspaceRoot, 'tsconfig.base.json'), 'utf8')) as TsconfigBase
).compilerOptions.paths;

const APP_AUTH_ROOT = 'libs/worker/github/';

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
function reachableFrom(entry: string): Map<string, string> {
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

async function lintHooksImport(specifier: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: workspaceRoot,
    overrideConfigFile: join(workspaceRoot, 'apps/hooks/eslint.config.mjs'),
  });
  const [result] = await eslint.lintText(`export { x } from '${specifier}';\n`, {
    filePath: join(workspaceRoot, 'apps/hooks/src/routes/isolation-probe.ts'),
  });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

describe('hooks Worker bundle isolation (threat model C6, #481)', () => {
  it('reaches no module of @worker/github from the Worker entry', () => {
    const reached = reachableFrom('apps/hooks/src/main.ts');
    const appAuth = [...reached.keys()].filter((file) => file.startsWith(APP_AUTH_ROOT));
    expect(
      appAuth.map((file) => `${file} (imported by ${reached.get(file) ?? '?'})`),
      'the hooks bundle must not contain the app auth',
    ).toEqual([]);
    // The walk does reach the webhook half, so an empty result above is not an empty walk.
    expect(reached.has('libs/worker/vcs-github/src/lib/webhooks.ts')).toBe(true);
    expect(reached.has('libs/worker/vcs-github/src/lib/adapter.ts')).toBe(false);
  });

  it('keeps the webhooks entry point of @worker/vcs-github free of the adapter and the app auth', () => {
    const reached = [...reachableFrom('libs/worker/vcs-github/src/webhooks.ts').keys()];
    expect(
      reached.filter(
        (file) => file.startsWith(APP_AUTH_ROOT) || file === 'libs/worker/vcs-github/src/lib/adapter.ts',
      ),
    ).toEqual([]);
  });

  it('would catch the barrel: the full @worker/vcs-github entry does reach @worker/github', () => {
    const reached = [...reachableFrom('libs/worker/vcs-github/src/index.ts').keys()];
    expect(reached.some((file) => file.startsWith(APP_AUTH_ROOT))).toBe(true);
  });

  it.each(['@worker/github', '@worker/github/testing', '@worker/vcs-github'])(
    'refuses an import of %s in the hooks Worker (lint)',
    async (specifier) => {
      const messages = await lintHooksImport(specifier);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('threat model C6');
    },
  );

  it('lets the hooks Worker import @worker/vcs-github/webhooks', async () => {
    await expect(lintHooksImport('@worker/vcs-github/webhooks')).resolves.toEqual([]);
  });
});
