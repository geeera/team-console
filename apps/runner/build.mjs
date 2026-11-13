import { chmodSync, cpSync, rmSync } from 'node:fs';
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
const RUNNER_LAUNCHER = 'team-console-runner';

/** `MAJOR.MINOR.PATCH[-pre]`, the shape `compareRunnerVersions` orders; the release workflow passes the tag's. */
const RELEASE_LABEL = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * What `src/version.ts` reports: `TC_RUNNER_VERSION` when set (refused unless it is a release label), else the
 * source's own dev label.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Record<string, string>}
 */
export function versionDefine(env) {
  const version = env['TC_RUNNER_VERSION'];
  if (version === undefined || version === '') {
    return {};
  }
  if (!RELEASE_LABEL.test(version)) {
    throw new Error(`TC_RUNNER_VERSION must be MAJOR.MINOR.PATCH[-pre], got ${JSON.stringify(version)}`);
  }
  return { __TC_RUNNER_VERSION__: JSON.stringify(version) };
}

/**
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {import('esbuild').BuildOptions}
 */
export function bundleOptions(env = {}) {
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
    define: versionDefine(env),
  };
}

async function main() {
  const { build } = await import('esbuild');
  rmSync(dirname(outFile), { recursive: true, force: true });
  await build({ ...bundleOptions(process.env), outfile: outFile });
  // `bin/` sits next to the bundle, as in the release tarball and the image.
  cpSync(join(appRoot, 'bin'), join(dirname(outFile), 'bin'), { recursive: true });
  chmodSync(join(dirname(outFile), 'bin', 'job-exec'), 0o555);
  chmodSync(join(dirname(outFile), 'bin', RUNNER_LAUNCHER), 0o555);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
