import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MIN_COMPARED,
  PINNED_BY_OVERRIDE,
  checkRuntimeTree,
  installedPackages,
  isAtLeast,
  overrideProblems,
  specialFiles,
} from './check-runtime-tree.mjs';

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
/** The runtime manifest as runtime-package.mjs writes it. */
const MANIFEST = {
  name: '@team-console/source',
  private: true,
  dependencies: { wrangler: WRANGLER },
  overrides: { miniflare: { sharp: '0.35.5', undici: '7.30.1' } },
};

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

  function install(key: string, version: string, manifest: Record<string, unknown> = {}): void {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, 'package.json'), JSON.stringify({ version, ...manifest }));
  }

  function installAll(packages: Packages): void {
    for (const [key, value] of Object.entries(packages)) install(key, value.version);
  }

  function check(
    workspace: Packages,
    runtime: Packages = workspace,
    platform = LINUX_X64,
    runtimeManifest: unknown = MANIFEST,
  ) {
    return checkRuntimeTree({
      root,
      workspaceLock: workspaceLockOf(workspace),
      runtimeLock: lockOf(runtime),
      runtimeManifest,
      platform,
    });
  }

  /** `.bin/<name> -> <target>` in the top node_modules. */
  function linkBin(name: string, target: string): void {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    symlinkSync(target, join(root, 'node_modules/.bin', name));
  }

  /** A file a package ships, as a `bin` entry names it. */
  function ship(path: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '#!/usr/bin/env node\n');
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
      install('node_modules/wrangler', WRANGLER, {
        bin: { wrangler: './bin/wrangler.js', wrangler2: 'bin/wrangler.js' },
      });
      install('node_modules/wrangler/node_modules/undici', '7.30.1', { name: 'undici', bin: 'cli.js' });
      install('node_modules/@img/colour', '1.0.0', { name: '@img/colour', bin: './colour.js' });
      writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
      ship('node_modules/wrangler/bin/wrangler.js');
      ship('node_modules/wrangler/node_modules/undici/cli.js');
      ship('node_modules/@img/colour/colour.js');
      linkBin('wrangler', '../wrangler/bin/wrangler.js');
      linkBin('wrangler2', '../wrangler/bin/wrangler.js');
      // A string `bin` is linked under the package's name without its scope.
      linkBin('colour', '../@img/colour/colour.js');
      mkdirSync(join(root, 'node_modules/wrangler/node_modules/.bin'));
      symlinkSync('../undici/cli.js', join(root, 'node_modules/wrangler/node_modules/.bin/undici'));
      expect(check(packages).problems).toEqual([]);
    });

    // #1005: a link into a real package passed whatever file it named and whatever it was called.
    it('fails on a .bin link its package does not declare in its bin map, by name or by file', () => {
      const packages = tree();
      installAll(packages);
      install('node_modules/wrangler', WRANGLER, { bin: { wrangler: './bin/wrangler.js' } });
      install('node_modules/sharp', '0.35.5', { bin: 'cli.js' });
      install('node_modules/@img/colour', '1.0.0', { bin: { colour: 7 } });
      ship('node_modules/wrangler/bin/wrangler.js');
      linkBin('wrangler', '../wrangler/bin/wrangler.js');
      linkBin('node', '../wrangler/bin/wrangler.js');
      linkBin('wrangler2', '../wrangler/templates/payload.js');
      linkBin('sharp', '../sharp/install/build.js');
      linkBin('sh', '../sharp/cli.js');
      linkBin('colour', '../@img/colour/colour.js');
      linkBin('filler', '../filler-0/cli.js');
      linkBin('toString', '../wrangler/bin/wrangler.js');
      linkBin('ghost', '../ghost/cli.js');
      linkBin('scope', '../@img');
      expect(check(packages).problems).toEqual([
        'node_modules/.bin/colour: @img/colour declares no "colour" executable',
        'node_modules/.bin/filler: filler-0 declares no "filler" executable',
        'node_modules/.bin/ghost: links into ghost, which has no package.json',
        'node_modules/.bin/node: wrangler declares no "node" executable',
        'node_modules/.bin/scope: links into @img, which has no package.json',
        'node_modules/.bin/sh: sharp declares no "sh" executable',
        'node_modules/.bin/sharp: links to sharp/install/build.js, but sharp declares sharp/cli.js',
        'node_modules/.bin/toString: wrangler declares no "toString" executable',
        'node_modules/.bin/wrangler2: wrangler declares no "wrangler2" executable',
      ]);
    });

    it('fails on a declared name that points at another file of the package', () => {
      const packages = tree();
      installAll(packages);
      install('node_modules/wrangler', WRANGLER, { bin: { wrangler: './bin/wrangler.js' } });
      linkBin('wrangler', '../wrangler/templates/payload.js');
      expect(check(packages).problems).toEqual([
        'node_modules/.bin/wrangler: links to wrangler/templates/payload.js, but wrangler declares wrangler/bin/wrangler.js',
      ]);
    });

    it('does not read the bin map of a symlinked package', () => {
      const packages = tree();
      installAll(packages);
      const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
      try {
        writeFileSync(join(outside, 'package.json'), JSON.stringify({ bin: { evil: 'cli.js' } }));
        symlinkSync(outside, join(root, 'node_modules/evil'));
        linkBin('evil', '../evil/cli.js');
        expect(check(packages).problems).toEqual([
          'node_modules/evil: a symlink in node_modules',
          'node_modules/.bin/evil: links into evil, which has no package.json',
        ]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // #1013: the declared path was compared as written, while the kernel follows every link on the way.
    describe('a declared .bin link that does not end at its own file', () => {
      it('fails when a linked directory inside the package takes the path out of the tree', () => {
        const packages = tree();
        installAll(packages);
        install('node_modules/wrangler', WRANGLER, { bin: { wrangler: 'cli.js' } });
        ship('node_modules/wrangler/cli.js');
        const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
        try {
          mkdirSync(join(outside, 'deep'));
          writeFileSync(join(outside, 'cli.js'), '');
          // Lexically `wrangler/cli.js`; resolved, `<outside>/cli.js`.
          symlinkSync(join(outside, 'deep'), join(root, 'node_modules/wrangler/sub'));
          linkBin('wrangler', '../wrangler/sub/../cli.js');
          expect(check(packages).problems).toEqual([
            'node_modules/.bin/wrangler: reaches its file through another symlink',
            'node_modules/wrangler/sub: a symlink in node_modules',
          ]);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      });

      it('fails when the declared file is itself a link to /bin/sh', () => {
        const packages = tree();
        installAll(packages);
        install('node_modules/wrangler', WRANGLER, { bin: { wrangler: 'cli.js' } });
        symlinkSync('/bin/sh', join(root, 'node_modules/wrangler/cli.js'));
        linkBin('wrangler', '../wrangler/cli.js');
        expect(check(packages).problems).toEqual([
          'node_modules/.bin/wrangler: reaches its file through another symlink',
          'node_modules/wrangler/cli.js: a symlink in node_modules',
        ]);
      });

      it('fails when the declared file is a link to another file of the same package', () => {
        const packages = tree();
        installAll(packages);
        install('node_modules/wrangler', WRANGLER, { bin: { wrangler: 'cli.js' } });
        ship('node_modules/wrangler/templates/payload.js');
        symlinkSync('templates/payload.js', join(root, 'node_modules/wrangler/cli.js'));
        linkBin('wrangler', '../wrangler/cli.js');
        expect(check(packages).problems).toEqual([
          'node_modules/.bin/wrangler: reaches its file through another symlink',
          'node_modules/wrangler/cli.js: a symlink in node_modules',
        ]);
      });

      it('fails when the declared file is missing or is a directory', () => {
        const packages = tree();
        installAll(packages);
        install('node_modules/wrangler', WRANGLER, { bin: { wrangler: 'cli.js', wrangler2: 'bin' } });
        mkdirSync(join(root, 'node_modules/wrangler/bin'));
        linkBin('wrangler', '../wrangler/cli.js');
        linkBin('wrangler2', '../wrangler/bin');
        expect(check(packages).problems).toEqual([
          'node_modules/.bin/wrangler: links to wrangler/cli.js, which does not exist',
          'node_modules/.bin/wrangler2: links to something that is not a regular file',
        ]);
      });

      it("holds the .bin of a package's own node_modules the same way", () => {
        const packages = tree();
        installAll(packages);
        const nested = 'node_modules/wrangler/node_modules';
        install(`${nested}/undici`, '7.30.1', { bin: 'cli.js' });
        symlinkSync('/bin/sh', join(root, nested, 'undici/cli.js'));
        mkdirSync(join(root, nested, '.bin'));
        symlinkSync('../undici/cli.js', join(root, nested, '.bin/undici'));
        expect(check(packages).problems).toEqual([
          `${nested}/.bin/undici: reaches its file through another symlink`,
          `${nested}/undici/cli.js: a symlink in node_modules`,
        ]);
      });
    });

    // #1013: a package.json that is not JSON behind a .bin link is drift with a name, not a crash of the walk.
    it('fails on a .bin link into a package whose package.json is not JSON', () => {
      const packages = tree();
      installAll(packages);
      mkdirSync(join(root, 'node_modules/stranger'));
      writeFileSync(join(root, 'node_modules/stranger/package.json'), '{ "bin": ');
      linkBin('stranger', '../stranger/cli.js');
      expect(check(packages).problems).toEqual([
        'node_modules/.bin/stranger: links into stranger, whose package.json is not JSON',
        'node_modules/stranger: on disk but not in the pruned lockfile',
      ]);
    });

    // #1019: a manifest that cannot be read was reported as "not JSON". Root reads it anyway, so no case to make.
    it.skipIf(process.getuid?.() === 0)(
      'fails on a .bin link into a package whose package.json cannot be read, and says why',
      () => {
        const packages = tree();
        installAll(packages);
        mkdirSync(join(root, 'node_modules/stranger'));
        writeFileSync(join(root, 'node_modules/stranger/package.json'), '{ "bin": "cli.js" }');
        chmodSync(join(root, 'node_modules/stranger/package.json'), 0o000);
        linkBin('stranger', '../stranger/cli.js');
        expect(check(packages).problems).toEqual([
          'node_modules/.bin/stranger: links into stranger, whose package.json cannot be read (EACCES)',
          'node_modules/stranger: on disk but not in the pruned lockfile',
        ]);
      },
    );

    it.each([
      ['a list', '[]'],
      ['a string', '"cli.js"'],
      ['null', 'null'],
    ])('fails on a .bin link into a package whose package.json is %s', (_case, manifest) => {
      const packages = tree();
      installAll(packages);
      mkdirSync(join(root, 'node_modules/stranger'));
      writeFileSync(join(root, 'node_modules/stranger/package.json'), manifest);
      linkBin('stranger', '../stranger/cli.js');
      expect(check(packages).problems).toContain(
        'node_modules/.bin/stranger: stranger declares no "stranger" executable',
      );
    });

    // #1005: equal in the lockfile and on disk says nothing about a mode bit or a device node.
    it('fails on a setuid or setgid bit and on a fifo anywhere in node_modules', () => {
      const packages = tree();
      installAll(packages);
      mkdirSync(join(root, 'node_modules/wrangler/bin'));
      writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), '');
      chmodSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), 0o4755);
      chmodSync(join(root, 'node_modules/sharp/package.json'), 0o2644);
      chmodSync(join(root, 'node_modules/filler-0'), 0o2755);
      expect(spawnSync('mkfifo', [join(root, 'node_modules/wrangler/bin/pipe')]).status).toBe(0);
      expect(check(packages).problems).toEqual([
        'node_modules/filler-0: setuid or setgid (mode 2755)',
        'node_modules/sharp/package.json: setuid or setgid (mode 2644)',
        'node_modules/wrangler/bin/pipe: a device, fifo or socket, not a file',
        'node_modules/wrangler/bin/wrangler.js: setuid or setgid (mode 4755)',
      ]);
    });

    // #1005: the overrides are the reason the tree is pruned rather than installed afresh (#263).
    it.each([
      ['no overrides', { ...MANIFEST, overrides: undefined }],
      ['empty overrides', { ...MANIFEST, overrides: {} }],
      ['overrides that are not a map', { ...MANIFEST, overrides: ['sharp'] }],
      ['overrides that are a string', { ...MANIFEST, overrides: 'sharp' }],
      ['no manifest object', null],
    ])('fails on a runtime manifest with %s', (_case, manifest) => {
      const packages = tree();
      installAll(packages);
      expect(check(packages, packages, LINUX_X64, manifest).problems).toEqual([
        'package.json: the runtime manifest has no overrides',
      ]);
    });

    // #1013: any non-empty map passed, whatever it held.
    it("fails on overrides that are not in npm's shape or do not pin sharp and undici", () => {
      const packages = tree();
      installAll(packages);
      const manifest = { ...MANIFEST, overrides: { miniflare: { sharp: 7, undici: '' }, note: null } };
      expect(check(packages, packages, LINUX_X64, manifest).problems).toEqual([
        'package.json: overrides."miniflare"."sharp" is neither a version nor a map of overrides',
        'package.json: overrides."miniflare"."undici" is neither a version nor a map of overrides',
        'package.json: overrides."note" is neither a version nor a map of overrides',
        'package.json: no override pins sharp',
        'package.json: no override pins undici',
      ]);
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
        runtimeManifest: MANIFEST,
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
      const result = checkRuntimeTree({
        root,
        workspaceLock: {},
        runtimeLock: {},
        runtimeManifest: MANIFEST,
        platform: LINUX_X64,
      });
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
      install('node_modules/a', '1.0.0', { bin: 'cli.js' });
      ship('node_modules/a/cli.js');
      linkBin('a', '../a/cli.js');
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

  describe('overrideProblems', () => {
    it("accepts the workspace's own overrides, which are what the runtime manifest carries", () => {
      const workspace: unknown = JSON.parse(
        readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
      );
      expect(overrideProblems(workspace)).toEqual([]);
    });

    // #1019: the pins are named twice, here and in the Dockerfile's `npm ls`; the two must agree.
    it('pins what the Dockerfile lists with `npm ls`, each under a package that depends on it', () => {
      const dockerfile = readFileSync(join(import.meta.dirname, '../../Dockerfile'), 'utf8');
      // The one `npm ls` that names packages: `npm ls --all` takes none.
      const listed = [...dockerfile.matchAll(/^\s*&& npm ls ([^-\s][^\\>&]*?)\s*\\$/gm)];
      expect(listed).toHaveLength(1);
      expect((listed[0]?.[1] ?? '').split(/\s+/).sort()).toEqual(Object.keys(PINNED_BY_OVERRIDE).sort());
      const lock = JSON.parse(readFileSync(join(import.meta.dirname, '../../package-lock.json'), 'utf8')) as {
        packages: Record<string, { dependencies?: Record<string, string> }>;
      };
      for (const [name, dependent] of Object.entries(PINNED_BY_OVERRIDE)) {
        expect(Object.keys(lock.packages[`node_modules/${dependent}`]?.dependencies ?? {}), name).toContain(name);
      }
    });

    it.each([
      ['a version at the top', { sharp: '0.35.5', undici: '7.30.1' }],
      ['a version under its parent', { miniflare: { sharp: '0.35.5', undici: '7.30.1' } }],
      ['a key with a range', { 'sharp@^0.34': '0.35.5', miniflare: { 'undici@7': '7.30.1' } }],
      ['the package itself as `.`', { sharp: { '.': '0.35.5', 'detect-libc': '2.0.0' }, undici: '7.30.1' }],
      ['a scoped package beside them', { '@img/colour': '1.0.0', sharp: '0.35.5', undici: '7.30.1' }],
    ])('accepts %s', (_case, overrides) => {
      expect(overrideProblems({ overrides }, { sharp: 'miniflare', undici: 'miniflare' })).toEqual([]);
    });

    it.each([
      ['a number', { sharp: 1 }, 'overrides."sharp" is neither a version nor a map of overrides'],
      ['an empty version', { sharp: '' }, 'overrides."sharp" is neither a version nor a map of overrides'],
      ['an empty map', { sharp: {} }, 'overrides."sharp" is neither a version nor a map of overrides'],
      ['a list', { sharp: ['0.35.5'] }, 'overrides."sharp" is neither a version nor a map of overrides'],
      ['null', { sharp: null }, 'overrides."sharp" is neither a version nor a map of overrides'],
      ['true', { sharp: true }, 'overrides."sharp" is neither a version nor a map of overrides'],
      [
        'a bad value two levels down',
        { miniflare: { sharp: { '.': 5 } } },
        'overrides."miniflare"."sharp"."." is neither a version nor a map of overrides',
      ],
      ['an empty name', { '': '1.0.0', sharp: '0.35.5' }, 'overrides."" names no package'],
      ['`.` at the top, where no package owns the map', { '.': '1.0.0' }, 'overrides."." names no package'],
    ])('reports %s', (_case, overrides, problem) => {
      expect(overrideProblems({ overrides }, {})).toEqual([`package.json: ${problem}`]);
    });

    it('reports each required pin no override names with a version', () => {
      // A pin only inside a name (`sharp-cli`) or as a parent (`undici: { … }`) is not a pin of the package.
      const overrides = { 'sharp-cli': '1.0.0', undici: { 'some-dependency': '1.0.0' } };
      expect(overrideProblems({ overrides })).toEqual([
        'package.json: no override pins sharp',
        'package.json: no override pins undici',
      ]);
    });

    // #1019: a pin counted at any depth, under any package.
    it.each([
      [
        'nested a level deeper',
        { miniflare: { youch: { sharp: '0.35.5' } }, undici: '7.30.1' },
        'overrides."miniflare"."youch"."sharp"',
      ],
      ['under another package', { nx: { sharp: '0.35.5' }, undici: '7.30.1' }, 'overrides."nx"."sharp"'],
      [
        'as `.` of a map under another package',
        { nx: { sharp: { '.': '0.35.5' } }, undici: '7.30.1' },
        'overrides."nx"."sharp"."."',
      ],
    ])('rejects a pin %s, which npm does not apply to the copy `npm ls` names', (_case, overrides, path) => {
      expect(overrideProblems({ overrides })).toEqual([
        `package.json: ${path} does not pin miniflare's sharp; only a pin at the top or under miniflare does`,
      ]);
    });

    it('accepts a misplaced pin beside one where it applies', () => {
      const overrides = { nx: { sharp: '0.35.5' }, miniflare: { 'sharp@0.35': '0.35.5', undici: '7.30.1' } };
      expect(overrideProblems({ overrides })).toEqual([]);
    });
  });

  describe('specialFiles', () => {
    // #1013: a link inside a package was reported by neither walk.
    it('reports a symlink anywhere but the .bin links, and does not follow it', () => {
      install('node_modules/a', '1.0.0');
      install('node_modules/@s/b/node_modules/c', '1.0.0');
      const outside = mkdtempSync(join(tmpdir(), 'runtime-tree-outside-'));
      try {
        writeFileSync(join(outside, 'tool'), '');
        chmodSync(join(outside, 'tool'), 0o4755);
        symlinkSync(outside, join(root, 'node_modules/a/linked'));
        symlinkSync('missing', join(root, 'node_modules/a/dangling'));
        symlinkSync('/bin/sh', join(root, 'node_modules/@s/b/node_modules/c/sh'));
        // The two places npm links executables in.
        mkdirSync(join(root, 'node_modules/.bin'));
        symlinkSync('../a/cli.js', join(root, 'node_modules/.bin/a'));
        mkdirSync(join(root, 'node_modules/@s/b/node_modules/.bin'));
        symlinkSync('../c/cli.js', join(root, 'node_modules/@s/b/node_modules/.bin/c'));
        // A `.bin` a package ships among its own files is not one of them.
        mkdirSync(join(root, 'node_modules/a/vendor/node_modules/.bin'), { recursive: true });
        symlinkSync('/bin/sh', join(root, 'node_modules/a/vendor/node_modules/.bin/sh'));
        mkdirSync(join(root, 'node_modules/a/.bin'));
        symlinkSync('/bin/sh', join(root, 'node_modules/a/.bin/sh'));
        expect(specialFiles(root)).toEqual([
          'node_modules/@s/b/node_modules/c/sh: a symlink in node_modules',
          'node_modules/a/.bin/sh: a symlink in node_modules',
          'node_modules/a/dangling: a symlink in node_modules',
          'node_modules/a/linked: a symlink in node_modules',
          'node_modules/a/vendor/node_modules/.bin/sh: a symlink in node_modules',
        ]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('finds nothing in a tree of plain files and directories', () => {
      install('node_modules/a', '1.0.0');
      expect(specialFiles(root)).toEqual([]);
    });

    it('keeps the sticky bit and the plain permission bits out of it', () => {
      install('node_modules/a', '1.0.0');
      chmodSync(join(root, 'node_modules/a'), 0o1777);
      expect(specialFiles(root)).toEqual([]);
    });

    it('is empty without a node_modules directory', () => {
      expect(specialFiles(root)).toEqual([]);
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
      writeFileSync(join(app(), 'package.json'), JSON.stringify(MANIFEST));
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

    // #998 SECURITY follow-up: without a script path the guard read "imported" and the process ended 0, unchecked.
    describe('without a script path', () => {
      it.each([
        ['with no arguments', ['--input-type=module']],
        ['as `-` with the arguments after it', ['--input-type=module', '-', '/absent.json', '/absent']],
      ])('fails when the script is piped to node instead of named, %s', (_case, nodeArgs) => {
        const result = spawnSync(process.execPath, nodeArgs, {
          input: readFileSync(SCRIPT, 'utf8'),
          encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.status).not.toBeNull();
        expect(result.stdout).toBe('');
      });

      it('says how to start it when there is no script path at all', () => {
        const result = spawnSync(process.execPath, ['--input-type=module'], {
          input: readFileSync(SCRIPT, 'utf8'),
          encoding: 'utf8',
        });
        expect(result.stderr).toContain('check-runtime-tree.mjs must be started as a file');
      });

      it('fails when it is loaded from node -e', () => {
        const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(SCRIPT)})`], {
          encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('check-runtime-tree.mjs must be started as a file');
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

      it('exits 2 when the root has no runtime manifest, or one that is not JSON', () => {
        const packages = tree();
        const absent = run(packages, packages, { tamper: () => rmSync(join(app(), 'package.json')) });
        expect(absent.status).toBe(2);
        expect(absent.stderr).toContain(cannotCheck);
        rmSync(app(), { recursive: true });
        const broken = run(packages, packages, {
          tamper: () => writeFileSync(join(app(), 'package.json'), '{'),
        });
        expect(broken.status).toBe(2);
        expect(broken.stderr).toContain(cannotCheck);
      });

      it('exits 1 when the runtime manifest lost its overrides', () => {
        const packages = tree();
        const bare = { ...MANIFEST, overrides: undefined };
        const result = run(packages, packages, {
          tamper: () => writeFileSync(join(app(), 'package.json'), JSON.stringify(bare)),
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('package.json: the runtime manifest has no overrides');
      });

      it('exits 1 on a .bin link into a package whose package.json is not JSON', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => {
            mkdirSync(join(app(), 'node_modules/stranger'));
            writeFileSync(join(app(), 'node_modules/stranger/package.json'), '{');
            mkdirSync(join(app(), 'node_modules/.bin'));
            symlinkSync('../stranger/cli.js', join(app(), 'node_modules/.bin/stranger'));
          },
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          'node_modules/.bin/stranger: links into stranger, whose package.json is not JSON',
        );
        expect(result.stderr).not.toContain(cannotCheck);
      });

      it('exits 1 on a symlink inside a package', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => symlinkSync('/bin/sh', join(app(), 'node_modules/sharp/sh')),
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('node_modules/sharp/sh: a symlink in node_modules');
      });

      it('exits 1 on a setuid file in a package', () => {
        const packages = tree();
        const result = run(packages, packages, {
          tamper: () => chmodSync(join(app(), 'node_modules/sharp/package.json'), 0o4644),
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('node_modules/sharp/package.json: setuid or setgid (mode 4644)');
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
