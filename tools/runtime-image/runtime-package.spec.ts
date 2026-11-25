import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeManifest } from './runtime-package.mjs';

const SCRIPT = join(import.meta.dirname, 'runtime-package.mjs');
const WORKSPACE_MANIFEST = join(import.meta.dirname, '../../package.json');

const workspace = {
  name: '@team-console/source',
  version: '0.0.0',
  license: 'UNLICENSED',
  scripts: { build: 'nx run-many -t build' },
  packageManager: 'npm@10.9.4',
  dependencies: { hono: '4.0.0' },
  devDependencies: { nx: '22.0.0', wrangler: '4.130.0' },
  overrides: { miniflare: { sharp: '0.35.5' }, undici: '7.30.1' },
};

/** What the script must write for `workspace`, byte for byte: the key order and the layout are part of it. */
const RUNTIME_JSON = `{
  "name": "@team-console/source",
  "private": true,
  "dependencies": {
    "wrangler": "4.130.0"
  },
  "overrides": {
    "miniflare": {
      "sharp": "0.35.5"
    },
    "undici": "7.30.1"
  }
}
`;

describe('runtime manifest', () => {
  it('keeps the name, wrangler as the only (production) dependency and the overrides, nothing else', () => {
    expect(runtimeManifest(workspace)).toEqual({
      name: '@team-console/source',
      private: true,
      dependencies: { wrangler: '4.130.0' },
      overrides: { miniflare: { sharp: '0.35.5' }, undici: '7.30.1' },
    });
  });

  it('pins wrangler and carries every override of the real workspace manifest', () => {
    const real = JSON.parse(readFileSync(WORKSPACE_MANIFEST, 'utf8')) as {
      name: string;
      devDependencies: Record<string, string>;
      overrides: Record<string, unknown>;
    };
    expect(Object.keys(real.overrides).length).toBeGreaterThan(0);
    expect(runtimeManifest(real)).toEqual({
      name: real.name,
      private: true,
      dependencies: { wrangler: real.devDependencies['wrangler'] },
      overrides: real.overrides,
    });
  });

  it.each([
    ['a manifest that is not an object', [], 'package.json is not an object'],
    ['null', null, 'package.json is not an object'],
    ['no name', { ...workspace, name: undefined }, 'package.json has no name'],
    ['no devDependencies', { ...workspace, devDependencies: undefined }, 'no devDependencies.wrangler'],
    ['no wrangler', { ...workspace, devDependencies: { nx: '22.0.0' } }, 'no devDependencies.wrangler'],
    [
      'a wrangler that is not a string',
      { ...workspace, devDependencies: { wrangler: 4 } },
      'no devDependencies.wrangler',
    ],
    [
      'wrangler only as a production dependency',
      { ...workspace, devDependencies: {}, dependencies: { wrangler: '4.130.0' } },
      'no devDependencies.wrangler',
    ],
    // #1005: a manifest without the overrides was written all the same, and the prune ran under it.
    ['no overrides', { ...workspace, overrides: undefined }, 'package.json has no overrides'],
    ['empty overrides', { ...workspace, overrides: {} }, 'package.json has no overrides'],
    ['overrides that are a list', { ...workspace, overrides: ['sharp'] }, 'package.json has no overrides'],
    ['overrides that are a string', { ...workspace, overrides: 'sharp' }, 'package.json has no overrides'],
  ])('throws on %s', (_case, manifest, message) => {
    expect(() => runtimeManifest(manifest)).toThrow(message);
  });

  describe('as the Dockerfile runs it', () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'runtime-package-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    const manifest = () => join(directory, 'package.json');

    function run(args: string[] = [], script = SCRIPT) {
      return spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    }

    it('rewrites package.json of the working directory in place, byte for byte', () => {
      writeFileSync(manifest(), JSON.stringify(workspace));
      const result = run();
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(manifest(), 'utf8')).toBe(RUNTIME_JSON);
    });

    it('rewrites the file named as its argument', () => {
      const named = join(directory, 'other.json');
      writeFileSync(named, JSON.stringify(workspace));
      expect(run([named]).status).toBe(0);
      expect(readFileSync(named, 'utf8')).toBe(RUNTIME_JSON);
    });

    it('still runs through a symlinked path', () => {
      const link = join(directory, 'linked-runtime-package.mjs');
      symlinkSync(SCRIPT, link);
      writeFileSync(manifest(), JSON.stringify(workspace));
      expect(run([], link).status).toBe(0);
      expect(readFileSync(manifest(), 'utf8')).toBe(RUNTIME_JSON);
    });

    it('fails and leaves the file as it was when the script is piped to node instead of named', () => {
      writeFileSync(manifest(), JSON.stringify(workspace));
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: directory,
        input: readFileSync(SCRIPT, 'utf8'),
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('runtime-package.mjs must be started as a file');
      expect(readFileSync(manifest(), 'utf8')).toBe(JSON.stringify(workspace));
    });

    it('exits 2 and leaves no manifest when there is no package.json', () => {
      const result = run();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('cannot write the runtime manifest to package.json: ');
    });

    it('exits 2 and leaves the file as it was when it is not JSON', () => {
      writeFileSync(manifest(), '{ "name": ');
      const result = run();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('cannot write the runtime manifest to package.json: ');
      expect(readFileSync(manifest(), 'utf8')).toBe('{ "name": ');
    });

    it('exits 2 and leaves the file as it was when the workspace does not pin wrangler', () => {
      const withoutWrangler = JSON.stringify({ ...workspace, devDependencies: { nx: '22.0.0' } });
      writeFileSync(manifest(), withoutWrangler);
      const result = run();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('package.json has no devDependencies.wrangler');
      expect(readFileSync(manifest(), 'utf8')).toBe(withoutWrangler);
    });

    it('exits 2 and leaves the file as it was when the workspace has no overrides', () => {
      const { overrides: _overrides, ...bare } = workspace;
      writeFileSync(manifest(), JSON.stringify(bare));
      const result = run();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('package.json has no overrides');
      expect(readFileSync(manifest(), 'utf8')).toBe(JSON.stringify(bare));
    });
  });
});
