import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MIN_COMPARED, checkRuntimeTree, installedPackages, isAtLeast } from './check-runtime-tree.mjs';

type Entry = {
  version: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  link?: boolean;
  os?: string[];
  cpu?: string[];
};
type Packages = Record<string, Entry>;
type RunOptions = {
  args?: string[];
  /** The path Node is started with; a symlink to the script in the entry-guard tests. */
  script?: string;
  nodeArgs?: string[];
  /** Runs after the fixture is written and before the script starts. */
  tamper?: () => void;
};

const SCRIPT = join(import.meta.dirname, 'check-runtime-tree.mjs');
const LINUX_X64 = { os: 'linux', cpu: 'x64' };
const WRANGLER = '4.130.0';

function entry(key: string, version: string, extra: Partial<Entry> = {}): Entry {
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
    ...extra,
  };
}

/** A lockfile-shaped tree the size of a real one: wrangler, sharp, a nested copy and enough filler for the floor. */
function tree(): Packages {
  const packages: Packages = {
    'node_modules/wrangler': entry('node_modules/wrangler', WRANGLER),
    'node_modules/sharp': entry('node_modules/sharp', '0.35.5'),
    'node_modules/@img/colour': entry('node_modules/@img/colour', '1.0.0'),
    'node_modules/wrangler/node_modules/undici': entry('node_modules/wrangler/node_modules/undici', '7.30.1'),
  };
  for (let index = 0; index < MIN_COMPARED; index += 1) {
    packages[`node_modules/filler-${index}`] = entry(`node_modules/filler-${index}`, `1.0.${index}`);
  }
  return packages;
}

function lockOf(packages: Packages, root: Record<string, unknown> = {}) {
  return { packages: { '': { version: '0.0.0', ...root }, ...packages } };
}

const workspaceLockOf = (packages: Packages) => lockOf(packages, { devDependencies: { wrangler: WRANGLER } });

describe('runtime tree check', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runtime-tree-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function install(key: string, version: string): void {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, 'package.json'), JSON.stringify({ version }));
  }

  function installAll(packages: Packages): void {
    for (const [key, value] of Object.entries(packages)) install(key, value.version);
  }

  function check(workspace: Packages, runtime: Packages = workspace, platform = LINUX_X64) {
    return checkRuntimeTree({
      root,
      workspaceLock: workspaceLockOf(workspace),
      runtimeLock: lockOf(runtime),
      platform,
    });
  }

  it('passes when the lockfiles and the disk agree, and reports how many packages it compared', () => {
    const packages = tree();
    installAll(packages);
    expect(check(packages)).toEqual({ compared: Object.keys(packages).length, problems: [] });
  });

  describe('drift', () => {
    it('fails when an installed version differs from the workspace lockfile', () => {
      const packages = tree();
      installAll(packages);
      install('node_modules/wrangler/node_modules/undici', '7.0.0');
      expect(check(packages).problems).toEqual([
        'node_modules/wrangler/node_modules/undici: installed 7.0.0 != workspace lockfile 7.30.1',
      ]);
    });

    it('fails when the pruned lockfile was re-resolved to another version', () => {
      const workspace = tree();
      const runtime = {
        ...workspace,
        'node_modules/@img/colour': entry('node_modules/@img/colour', '1.1.0'),
      };
      installAll(runtime);
      const { problems } = check(workspace, runtime);
      expect(problems).toContain(
        'node_modules/@img/colour: pruned lockfile version 1.1.0 != workspace lockfile 1.0.0',
      );
      expect(problems).toContain('node_modules/@img/colour: installed 1.1.0 != workspace lockfile 1.0.0');
    });

    it('fails when the pruned lockfile has the same version from another tarball', () => {
      const workspace = tree();
      const runtime = {
        ...workspace,
        'node_modules/sharp': entry('node_modules/sharp', '0.35.5', {
          resolved: 'https://example.test/sharp-0.35.5.tgz',
          integrity: 'sha512-other',
        }),
      };
      installAll(runtime);
      expect(check(workspace, runtime).problems).toEqual([
        'node_modules/sharp: pruned lockfile resolved https://example.test/sharp-0.35.5.tgz != workspace lockfile https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz',
        'node_modules/sharp: pruned lockfile integrity sha512-other != workspace lockfile sha512-sharp-0.35.5',
      ]);
    });

    it('fails when the pruned lockfile lists a package the workspace lockfile does not have', () => {
      const workspace = tree();
      const runtime = { ...workspace, 'node_modules/stranger': entry('node_modules/stranger', '1.0.0') };
      installAll(runtime);
      expect(check(workspace, runtime).problems).toEqual([
        'node_modules/stranger: in the pruned lockfile but not in the workspace lockfile',
      ]);
    });

    it('fails when a package is on disk but not in the pruned lockfile', () => {
      const packages = tree();
      installAll(packages);
      install('node_modules/stranger', '1.0.0');
      install('node_modules/@scope/stranger', '1.0.0');
      install('node_modules/wrangler/node_modules/stranger', '1.0.0');
      expect(check(packages).problems).toEqual([
        'node_modules/@scope/stranger: on disk but not in the pruned lockfile',
        'node_modules/stranger: on disk but not in the pruned lockfile',
        'node_modules/wrangler/node_modules/stranger: on disk but not in the pruned lockfile',
      ]);
    });

    it('fails when a directory on disk has no package.json, in the lockfile or not', () => {
      const packages = tree();
      installAll(packages);
      rmSync(join(root, 'node_modules/@img/colour/package.json'));
      mkdirSync(join(root, 'node_modules/hollow'));
      expect(check(packages).problems).toEqual([
        'node_modules/@img/colour: missing',
        'node_modules/@img/colour: on disk without a package.json',
        'node_modules/hollow: on disk but not in the pruned lockfile',
      ]);
    });

    it('fails on a symlink in node_modules and does not follow it', () => {
      const packages = tree();
      installAll(packages);
      const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
      try {
        symlinkSync(outside, join(root, 'node_modules/linked'));
        symlinkSync(outside, join(root, 'node_modules/@linked'));
        expect(check(packages).problems).toEqual([
          'node_modules/@linked: a symlink in node_modules',
          'node_modules/linked: a symlink in node_modules',
        ]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails on a symlinked node_modules and does not look behind it', () => {
      const packages = tree();
      installAll(packages);
      const nested = 'node_modules/wrangler/node_modules';
      const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
      try {
        // The locked package is reachable through the link, so only the walk can tell.
        renameSync(join(root, nested, 'undici'), join(outside, 'undici'));
        mkdirSync(join(outside, 'stranger'));
        writeFileSync(join(outside, 'stranger/package.json'), JSON.stringify({ version: '1.0.0' }));
        rmSync(join(root, nested), { recursive: true });
        symlinkSync(outside, join(root, nested));
        expect(check(packages).problems).toEqual([`${nested}: a symlink in node_modules`]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails when the top node_modules itself is a symlink', () => {
      const packages = tree();
      installAll(packages);
      const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
      try {
        renameSync(join(root, 'node_modules'), join(outside, 'node_modules'));
        symlinkSync(join(outside, 'node_modules'), join(root, 'node_modules'));
        const result = check(packages);
        expect(result.compared).toBe(Object.keys(packages).length);
        expect(result.problems).toEqual([
          'node_modules: a symlink in node_modules',
          'sharp: not installed, expected >= 0.35.5',
        ]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails on a plain file where npm puts packages', () => {
      const packages = tree();
      installAll(packages);
      writeFileSync(join(root, 'node_modules/payload.js'), '');
      writeFileSync(join(root, 'node_modules/@img/payload.js'), '');
      writeFileSync(join(root, 'node_modules/@payload'), '');
      mkdirSync(join(root, 'node_modules/sharp/node_modules'));
      writeFileSync(join(root, 'node_modules/sharp/node_modules/payload.js'), '');
      writeFileSync(join(root, 'node_modules/@img/colour/node_modules'), '');
      expect(check(packages).problems).toEqual([
        'node_modules/@img/colour/node_modules: a file, not a directory',
        'node_modules/@img/payload.js: a file where a package directory belongs',
        'node_modules/@payload: a file where a scope directory belongs',
        'node_modules/payload.js: a file where a package directory belongs',
        'node_modules/sharp/node_modules/payload.js: a file where a package directory belongs',
      ]);
    });

    it('fails on a dot entry npm does not create, directory or file, at any depth', () => {
      const packages = tree();
      installAll(packages);
      install('node_modules/.hidden', '1.0.0');
      install('node_modules/@img/.hidden', '1.0.0');
      install('node_modules/wrangler/node_modules/.hidden', '1.0.0');
      writeFileSync(join(root, 'node_modules/.payload.js'), '');
      // The hidden lockfile is npm's at the top only, and only as a file.
      writeFileSync(join(root, 'node_modules/wrangler/node_modules/.package-lock.json'), '{}');
      expect(check(packages).problems).toEqual([
        'node_modules/.hidden: a dot entry npm does not create',
        'node_modules/.payload.js: a dot entry npm does not create',
        'node_modules/@img/.hidden: a dot entry npm does not create',
        'node_modules/wrangler/node_modules/.hidden: a dot entry npm does not create',
        'node_modules/wrangler/node_modules/.package-lock.json: a dot entry npm does not create',
      ]);
    });

    it('fails when the hidden lockfile or .bin is not what npm writes', () => {
      const packages = tree();
      installAll(packages);
      mkdirSync(join(root, 'node_modules/.package-lock.json'));
      writeFileSync(join(root, 'node_modules/.bin'), '');
      expect(check(packages).problems).toEqual([
        'node_modules/.bin: a file, not the directory npm links executables in',
        'node_modules/.package-lock.json: a dot entry npm does not create',
      ]);
    });

    it('accepts the dot entries npm writes: the hidden lockfile and .bin links into its own packages', () => {
      const packages = tree();
      installAll(packages);
      writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
      mkdirSync(join(root, 'node_modules/.bin'));
      symlinkSync('../wrangler/bin/wrangler.js', join(root, 'node_modules/.bin/wrangler'));
      mkdirSync(join(root, 'node_modules/wrangler/node_modules/.bin'));
      symlinkSync('../undici/cli.js', join(root, 'node_modules/wrangler/node_modules/.bin/undici'));
      expect(check(packages).problems).toEqual([]);
    });

    it('fails on anything in .bin but a link into a package of the same node_modules', () => {
      const packages = tree();
      installAll(packages);
      const bin = join(root, 'node_modules/.bin');
      mkdirSync(join(bin, 'directory'), { recursive: true });
      writeFileSync(join(bin, 'script'), '#!/bin/sh\n');
      symlinkSync('/bin/sh', join(bin, 'absolute'));
      symlinkSync('../../outside.js', join(bin, 'escapes'));
      symlinkSync('script', join(bin, 'sibling'));
      symlinkSync('..', join(bin, 'modules'));
      symlinkSync('../.payload.js', join(bin, 'hidden'));
      expect(check(packages).problems).toEqual([
        'node_modules/.bin/absolute: links outside the packages of its node_modules',
        'node_modules/.bin/directory: not a link to a package executable',
        'node_modules/.bin/escapes: links outside the packages of its node_modules',
        'node_modules/.bin/hidden: links outside the packages of its node_modules',
        'node_modules/.bin/modules: links outside the packages of its node_modules',
        'node_modules/.bin/script: not a link to a package executable',
        'node_modules/.bin/sibling: links outside the packages of its node_modules',
      ]);
    });

    it('fails on a symlinked .bin and does not read it', () => {
      const packages = tree();
      installAll(packages);
      const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
      try {
        writeFileSync(join(outside, 'script'), '');
        symlinkSync(outside, join(root, 'node_modules/.bin'));
        expect(check(packages).problems).toEqual(['node_modules/.bin: a symlink in node_modules']);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails on a link entry in the pruned lockfile', () => {
      const workspace = {
        ...tree(),
        'node_modules/linked': entry('node_modules/linked', '1.0.0', { link: true }),
      };
      installAll(workspace);
      expect(check(workspace).problems).toEqual([
        'node_modules/linked: a link, the runtime tree has no workspaces',
      ]);
    });
  });

  describe('missing packages', () => {
    const platformBuild = (os: string, cpu: string, extra: Partial<Entry> = {}) =>
      entry('node_modules/@esbuild/build', '1.0.0', { os: [os], cpu: [cpu], ...extra });

    function checkWithout(missing: Entry) {
      const packages = tree();
      installAll(packages);
      return check({ ...packages, 'node_modules/@esbuild/build': missing }).problems;
    }

    it('accepts a missing optional build for another OS or CPU', () => {
      expect(checkWithout(platformBuild('darwin', 'x64', { optional: true }))).toEqual([]);
      expect(checkWithout(platformBuild('linux', 'arm64', { optional: true }))).toEqual([]);
      expect(
        checkWithout(entry('node_modules/@esbuild/build', '1.0.0', { os: ['!linux'], optional: true })),
      ).toEqual([]);
    });

    it('fails when an optional build for this platform is missing', () => {
      expect(checkWithout(platformBuild('linux', 'x64', { optional: true }))).toEqual([
        'node_modules/@esbuild/build: missing, though it targets linux/x64',
      ]);
    });

    it('fails when an optional package with no platform constraint is missing', () => {
      expect(checkWithout(entry('node_modules/@esbuild/build', '1.0.0', { optional: true }))).toEqual([
        'node_modules/@esbuild/build: missing, though it targets linux/x64',
      ]);
    });

    it('fails when a non-optional platform package is missing, for this platform or another', () => {
      expect(checkWithout(platformBuild('linux', 'x64'))).toEqual(['node_modules/@esbuild/build: missing']);
      expect(checkWithout(platformBuild('darwin', 'arm64'))).toEqual([
        'node_modules/@esbuild/build: missing',
      ]);
    });
  });

  describe('vacuous comparison', () => {
    it('fails on empty lockfiles and an empty directory', () => {
      const result = checkRuntimeTree({
        root,
        workspaceLock: { packages: {} },
        runtimeLock: { packages: {} },
        platform: LINUX_X64,
      });
      expect(result).toEqual({
        compared: 0,
        problems: [
          `only 0 packages compared, expected at least ${MIN_COMPARED}`,
          'the workspace lockfile has no devDependencies.wrangler',
          'sharp: not installed, expected >= 0.35.5',
        ],
      });
    });

    it('fails when the lockfiles have no packages at all', () => {
      const result = checkRuntimeTree({ root, workspaceLock: {}, runtimeLock: {}, platform: LINUX_X64 });
      expect(result.compared).toBe(0);
      expect(result.problems).toContain(`only 0 packages compared, expected at least ${MIN_COMPARED}`);
    });

    it('fails when the lockfiles agree but nothing is installed', () => {
      const packages = tree();
      const { compared, problems } = check(packages);
      expect(compared).toBe(0);
      expect(problems).toContain(`only 0 packages compared, expected at least ${MIN_COMPARED}`);
      expect(problems).toContain('node_modules/wrangler: missing');
    });

    it('fails when fewer packages than the floor were compared', () => {
      const packages: Packages = {
        'node_modules/wrangler': entry('node_modules/wrangler', WRANGLER),
        'node_modules/sharp': entry('node_modules/sharp', '0.35.5'),
      };
      installAll(packages);
      expect(check(packages).problems).toEqual([
        `only 2 packages compared, expected at least ${MIN_COMPARED}`,
      ]);
    });

    it('fails when wrangler is not in the tree', () => {
      const packages = tree();
      delete packages['node_modules/wrangler'];
      delete packages['node_modules/wrangler/node_modules/undici'];
      packages['node_modules/filler-more'] = entry('node_modules/filler-more', '1.0.0');
      packages['node_modules/filler-extra'] = entry('node_modules/filler-extra', '1.0.0');
      installAll(packages);
      expect(check(packages).problems).toEqual([
        `node_modules/wrangler: not in the runtime tree, expected ${WRANGLER}`,
      ]);
    });

    it('fails when wrangler is not the version package.json pins', () => {
      const packages = { ...tree(), 'node_modules/wrangler': entry('node_modules/wrangler', '4.129.0') };
      installAll(packages);
      expect(check(packages).problems).toEqual([
        `node_modules/wrangler: installed 4.129.0 != package.json ${WRANGLER}`,
      ]);
    });

    it('fails when sharp is not in the tree', () => {
      const packages = tree();
      delete packages['node_modules/sharp'];
      packages['node_modules/filler-extra'] = entry('node_modules/filler-extra', '1.0.0');
      installAll(packages);
      expect(check(packages).problems).toEqual(['sharp: not installed, expected >= 0.35.5']);
    });

    it('fails when any installed sharp is below the floor, even if the lockfile agrees with it', () => {
      const nested = 'node_modules/wrangler/node_modules/sharp';
      const packages = { ...tree(), [nested]: entry(nested, '0.35.4') };
      installAll(packages);
      expect(check(packages).problems).toEqual([`${nested}: 0.35.4 is below 0.35.5`]);
    });
  });

  describe('installedPackages', () => {
    it('lists packages by npm layout only, not package.json files inside a package or npm dot entries', () => {
      install('node_modules/a', '1.0.0');
      install('node_modules/a/node_modules/@s/b', '1.0.0');
      install('node_modules/a/fixtures/node_modules-like/c', '1.0.0');
      install('node_modules/a/.hidden', '1.0.0');
      mkdirSync(join(root, 'node_modules/.bin'));
      symlinkSync('../a/cli.js', join(root, 'node_modules/.bin/a'));
      writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
      expect(installedPackages(root)).toEqual({
        packages: ['node_modules/a', 'node_modules/a/node_modules/@s/b'],
        links: [],
        unexpected: [],
      });
    });

    it('reports what is neither a package nor an npm dot entry, apart from the packages', () => {
      install('node_modules/a', '1.0.0');
      install('node_modules/.bin/d', '1.0.0');
      install('node_modules/@s/.hidden', '1.0.0');
      writeFileSync(join(root, 'node_modules/file'), '');
      symlinkSync('a', join(root, 'node_modules/.linked'));
      expect(installedPackages(root)).toEqual({
        packages: ['node_modules/a'],
        links: ['node_modules/.linked'],
        unexpected: [
          'node_modules/.bin/d: not a link to a package executable',
          'node_modules/@s/.hidden: a dot entry npm does not create',
          'node_modules/file: a file where a package directory belongs',
        ],
      });
    });

    it('is empty without a node_modules directory', () => {
      expect(installedPackages(root)).toEqual({ packages: [], links: [], unexpected: [] });
    });
  });

  describe('isAtLeast', () => {
    it.each([
      ['0.35.5', true],
      ['0.35.6', true],
      ['0.36.0', true],
      ['1.0.0', true],
      ['0.100.0', true],
      ['0.35.4', false],
      ['0.34.9', false],
      ['0.35.5-rc.1', false],
      ['0.36.0-rc.1', false],
      ['latest', false],
      [undefined, false],
    ])('%s >= 0.35.5 is %s', (version, expected) => {
      expect(isAtLeast(version, '0.35.5')).toBe(expected);
    });
  });

  describe('as the Dockerfile runs it', () => {
    const workspaceLock = () => join(root, 'workspace-lock.json');
    const app = () => join(root, 'app');

    function run(
      workspace: Packages,
      runtime: Packages,
      { args, script = SCRIPT, nodeArgs = [], tamper }: RunOptions = {},
    ) {
      mkdirSync(app());
      writeFileSync(workspaceLock(), JSON.stringify(workspaceLockOf(workspace)));
      writeFileSync(join(app(), 'package-lock.json'), JSON.stringify(lockOf(runtime)));
      for (const [key, value] of Object.entries(runtime)) {
        mkdirSync(join(app(), key), { recursive: true });
        writeFileSync(join(app(), key, 'package.json'), JSON.stringify({ version: value.version }));
      }
      tamper?.();
      // The lockfile is written for every platform; the fixture has no platform builds, so any host passes.
      return spawnSync(process.execPath, [...nodeArgs, script, ...(args ?? [workspaceLock(), app()])], {
        cwd: dirname(SCRIPT),
        encoding: 'utf8',
      });
    }

    it('exits 0 and prints the count on a matching tree', () => {
      const packages = tree();
      const result = run(packages, packages);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        `runtime tree matches package-lock.json: ${Object.keys(packages).length} packages compared\n`,
      );
      expect(result.status).toBe(0);
    });

    it('exits 1 and names the package on a crafted drift', () => {
      const workspace = tree();
      const runtime = { ...workspace, 'node_modules/sharp': entry('node_modules/sharp', '0.35.6') };
      const result = run(workspace, runtime);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('runtime tree drifts from package-lock.json:');
      expect(result.stderr).toContain('node_modules/sharp: installed 0.35.6 != workspace lockfile 0.35.5');
    });

    it('exits 1 on an empty tree', () => {
      const result = run({}, {});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`only 0 packages compared, expected at least ${MIN_COMPARED}`);
    });

    it('exits 2 without the workspace lockfile argument', () => {
      const result = run({}, {}, { args: [] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage:');
    });

    describe('through a symlinked path', () => {
      function linked(): string {
        const link = join(root, 'linked-check.mjs');
        symlinkSync(SCRIPT, link);
        return link;
      }

      it('still checks: exits 0 with the count on a matching tree', () => {
        const packages = tree();
        const result = run(packages, packages, { script: linked() });
        expect(result.stdout).toBe(
          `runtime tree matches package-lock.json: ${Object.keys(packages).length} packages compared\n`,
        );
        expect(result.status).toBe(0);
      });

      it('still checks: exits 1 on a drift', () => {
        const workspace = tree();
        const runtime = { ...workspace, 'node_modules/sharp': entry('node_modules/sharp', '0.35.6') };
        const result = run(workspace, runtime, { script: linked() });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('node_modules/sharp: installed 0.35.6 != workspace lockfile 0.35.5');
      });

      it('still checks when Node keeps the symlinked path as the main module', () => {
        const result = run({}, {}, { script: linked(), nodeArgs: ['--preserve-symlinks-main'] });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`only 0 packages compared, expected at least ${MIN_COMPARED}`);
      });
    });

    describe('when an input cannot be read or parsed', () => {
      const cannotCheck = 'cannot check the runtime tree: ';

      it('exits 2 when the workspace lockfile does not exist', () => {
        const packages = tree();
        const result = run(packages, packages, { args: [join(root, 'absent.json'), app()] });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(cannotCheck);
        expect(result.stderr).toContain('absent.json');
      });

      it('exits 2 when the workspace lockfile is not JSON', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => writeFileSync(workspaceLock(), '{ "packages": '),
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(cannotCheck);
      });

      it('exits 2 when the root has no pruned lockfile', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => rmSync(join(app(), 'package-lock.json')),
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(cannotCheck);
        expect(result.stderr).toContain('package-lock.json');
      });

      it('exits 2 when the pruned lockfile is not JSON', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => writeFileSync(join(app(), 'package-lock.json'), 'not json'),
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(cannotCheck);
      });

      it('exits 2 when an installed package.json is not JSON', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => writeFileSync(join(app(), 'node_modules/sharp/package.json'), '{'),
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(cannotCheck);
      });

      it('exits 2 when the root does not exist', () => {
        const packages = tree();
        const result = run(packages, packages, { args: [workspaceLock(), join(root, 'absent')] });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(cannotCheck);
      });
    });
  });
});
