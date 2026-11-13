import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The runner ships as one file (ADR 0008 decision 1, architect note on #468): an ESM bundle for Node 22 with every
 * workspace import inlined and nothing but `node:*` left external, so a customer installs no `node_modules`.
 * `bundle.spec.ts` builds with these same options and checks the metafile.
 */
const appRoot = dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = resolve(appRoot, '../..');
export const outFile = join(workspaceRoot, 'dist/apps/runner/team-console-runner.mjs');

/** @returns {import('esbuild').BuildOptions} */
export function bundleOptions() {
  return {
    absWorkingDir: workspaceRoot,
    entryPoints: [join(appRoot, 'src/main.ts')],
    tsconfig: join(appRoot, 'tsconfig.app.json'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Only built-ins stay external; a bare package import is bundled, and bundle.spec.ts refuses one.
    packages: 'bundle',
    external: ['node:*'],
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
  };
}

async function main() {
  const { build } = await import('esbuild');
  rmSync(dirname(outFile), { recursive: true, force: true });
  await build({ ...bundleOptions(), outfile: outFile });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
