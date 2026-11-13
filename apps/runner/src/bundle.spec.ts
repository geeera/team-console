import { build, type Metafile } from 'esbuild';
import { relative } from 'node:path';
import { bundleOptions, workspaceRoot } from '../build.mjs';

/**
 * Threat model C11 row 3 ("a minimal dependency set is an acceptance criterion of 2-B"), met by construction
 * (ADR 0008 decision 1): the runner bundles to one file whose every input is this app or a shared workspace lib,
 * and whose only imports left are Node built-ins. A package that slipped in — even one already in the lockfile —
 * fails here.
 */

/** The runner and `scope:shared` workspace code (the contracts reach `@shared/plain-text`); never a package. */
const ALLOWED_INPUT_ROOTS = ['apps/runner/src/', 'libs/shared/'];

describe('runner bundle (C11 row 3: no runtime dependency)', () => {
  let metafile: Metafile;
  let outputs: string[];
  let text: string;

  beforeAll(async () => {
    const result = await build({ ...bundleOptions(), outfile: 'team-console-runner.mjs', write: false });
    metafile = result.metafile ?? { inputs: {}, outputs: {} };
    outputs = result.outputFiles.map((file) => relative(workspaceRoot, file.path));
    text = result.outputFiles[0]?.text ?? '';
  }, 30_000);

  it('is one file', () => {
    expect(outputs).toEqual(['team-console-runner.mjs']);
  });

  it('inlines only the runner and shared workspace libs — nothing from node_modules', () => {
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.length).toBeGreaterThan(5);
    expect(inputs.filter((input) => input.includes('node_modules'))).toEqual([]);
    expect(inputs.filter((input) => !ALLOWED_INPUT_ROOTS.some((root) => input.startsWith(root)))).toEqual([]);
  });

  it('leaves only node: built-ins external', () => {
    const external = Object.values(metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((imported) => imported.external)
      .map((imported) => imported.path);
    expect(external.length).toBeGreaterThan(0);
    expect(external.filter((path) => !path.startsWith('node:'))).toEqual([]);
  });

  it('is an executable ESM file for Node', () => {
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(text).not.toMatch(/\brequire\(/);
  });
});
