#!/usr/bin/env node
// The root Dockerfile's `runtime-deps` stage runs this before `npm prune` (#263): it rewrites the workspace
// package.json in place to the runtime image's manifest, so that pruning the `npm ci` tree leaves wrangler's
// own tree at the lockfile's versions. No dependencies, for the same reason as check-runtime-tree.mjs: the
// Dockerfile copies this one file into a stage that has nothing but Node.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ name: string, private: true, dependencies: { wrangler: string }, overrides?: unknown }} RuntimeManifest
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The runtime manifest for a workspace manifest: wrangler alone, at the workspace's version, under the
 * workspace's `overrides` (sharp and undici are pinned there).
 * @param {unknown} workspace the parsed workspace package.json
 * @returns {RuntimeManifest}
 */
export function runtimeManifest(workspace) {
  if (!isRecord(workspace)) throw new Error('package.json is not an object');
  const { name, devDependencies, overrides } = workspace;
  if (typeof name !== 'string' || name === '') throw new Error('package.json has no name');
  const wrangler = isRecord(devDependencies) ? devDependencies['wrangler'] : undefined;
  if (typeof wrangler !== 'string' || wrangler === '') {
    throw new Error('package.json has no devDependencies.wrangler');
  }
  // A production dependency, so `npm ls` under the image's NODE_ENV=production still lists the tree.
  return { name, private: true, dependencies: { wrangler }, overrides };
}

/**
 * @param {string[]} argv `[package.json]`, the file rewritten in place
 * @returns {0 | 2} 2 when the manifest cannot be read, parsed, used or written
 */
function main(argv) {
  const path = argv[0] ?? 'package.json';
  try {
    const runtime = runtimeManifest(JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(path, `${JSON.stringify(runtime, null, 2)}\n`);
  } catch (error) {
    console.error(
      `cannot write the runtime manifest to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  return 0;
}

/** As in check-runtime-tree.mjs: realpath on both sides, so a symlinked entry still runs `main()`. */
function isEntryPoint() {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
