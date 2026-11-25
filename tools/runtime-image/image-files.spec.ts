import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER,
  RUNTIME_COPIES,
  baseImageOf,
  checkImageFiles,
  expectedFiles,
  listFiles,
  rootsOf,
} from './image-files.mjs';

type Entry = ReturnType<typeof listFiles>[number];
type Listings = Parameters<typeof checkImageFiles>[0];

const SCRIPT = join(import.meta.dirname, 'image-files.mjs');
const DOCKERFILE = readFileSync(join(import.meta.dirname, '../../Dockerfile'), 'utf8');
const ROOT = { uid: 0, gid: 0 };

const directory = (path: string, owner = ROOT): Entry => ({ path, type: 'directory', mode: '755', ...owner });
const file = (path: string, content: string, owner = ROOT, mode = '644'): Entry => ({
  path,
  type: 'file',
  mode,
  ...owner,
  size: content.length,
  sha256: `sha-of-${content}`,
});
const link = (path: string, target: string, owner = ROOT): Entry => ({
  path,
  type: 'link',
  mode: '777',
  ...owner,
  link: target,
});

const COPIES = [
  { stage: 'runtime-deps', path: '/app/package.json' },
  { stage: 'runtime-deps', path: '/app/node_modules' },
  { stage: 'build', path: '/app/dist/apps/api' },
] as const;

/** Listings of an image that is exactly its base plus the three copies above. */
function listings(): Listings {
  const base = [directory('/'), directory('/etc'), file('/etc/passwd', 'root'), link('/bin', 'usr/bin')];
  const deps = [
    file('/app/package.json', '{}'),
    directory('/app/node_modules'),
    directory('/app/node_modules/.bin'),
    link('/app/node_modules/.bin/wrangler', '../wrangler/bin/wrangler.js'),
    directory('/app/node_modules/wrangler'),
    file('/app/node_modules/wrangler/package.json', 'wrangler', ROOT, '755'),
  ];
  const build = [directory('/app/dist/apps/api'), file('/app/dist/apps/api/main.js', 'bundle')];
  const runtime = [
    ...base,
    directory('/app', OWNER),
    directory('/app/dist', OWNER),
    directory('/app/dist/apps', OWNER),
    ...[...deps, ...build].map((entry) => ({ ...entry, ...OWNER })),
  ];
  return { base, 'runtime-deps': deps, build, runtime };
}

const check = (changed: Listings) => checkImageFiles(changed, COPIES);
const without = (entries: Entry[], path: string) => entries.filter((entry) => entry.path !== path);
const replaced = (entries: Entry[], path: string, change: Partial<Entry>) =>
  entries.map((entry) => (entry.path === path ? { ...entry, ...change } : entry));

describe('runtime image file list', () => {
  describe('the table of copies', () => {
    it('is what the runtime stage of the Dockerfile copies, line for line', () => {
      const runtimeStage = DOCKERFILE.slice(DOCKERFILE.indexOf('FROM ${NODE_IMAGE} AS runtime\n'));
      const copies = [...runtimeStage.matchAll(/^COPY (.*)$/gm)].flatMap((match) => {
        const words = (match[1] ?? '').split(/\s+/);
        expect(words[0]).toBe('--chown=node:node');
        const stage = /^--from=(.+)$/.exec(words[1] ?? '')?.[1];
        const sources = words.slice(2, -1);
        const destination = words.at(-1) ?? '';
        return sources.map((source) => {
          // `./` takes the sources under their own names; any other destination must be the source's own path.
          const landsAt =
            destination === './' ? `/app/${source.split('/').at(-1)}` : `/app/${destination.slice(2)}`;
          expect(destination.startsWith('./'), destination).toBe(true);
          expect(landsAt, match[0]).toBe(source);
          return { stage, path: source };
        });
      });
      expect(copies).toEqual(RUNTIME_COPIES);
      expect(copies.length).toBeGreaterThan(0);
    });

    it('is the only way files reach the runtime stage: no ADD, no RUN that writes under /app but the chown', () => {
      const runtimeStage = DOCKERFILE.slice(DOCKERFILE.indexOf('FROM ${NODE_IMAGE} AS runtime\n'));
      const instructions = runtimeStage
        .split('\n')
        .filter((line) => /^[A-Z]+ /.test(line))
        .map((line) => line.split(' ')[0]);
      expect(runtimeStage).toContain('\nWORKDIR /app\nRUN chown node:node /app\n');
      expect(instructions.filter((instruction) => instruction === 'RUN')).toHaveLength(1);
      expect(instructions).not.toContain('ADD');
    });

    it('lists the whole base and final image, and only the copied paths of the stages between', () => {
      expect(rootsOf('base')).toEqual(['/']);
      expect(rootsOf('runtime')).toEqual(['/']);
      expect(rootsOf('runtime-deps')).toEqual([
        '/app/package.json',
        '/app/package-lock.json',
        '/app/node_modules',
      ]);
      expect(rootsOf('build')).toEqual([
        '/app/dist/apps/console/browser',
        '/app/dist/apps/api',
        '/app/apps/api/wrangler.jsonc',
        '/app/apps/api/migrations',
      ]);
    });
  });

  describe('baseImageOf', () => {
    it('reads the digest-pinned default of ARG NODE_IMAGE from the real Dockerfile', () => {
      expect(baseImageOf(DOCKERFILE)).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
    });

    it.each([
      ['no ARG NODE_IMAGE', 'FROM node:22\n', 'expected one ARG NODE_IMAGE=…, found 0'],
      ['two of them', 'ARG NODE_IMAGE=a\nARG NODE_IMAGE=b\n', 'expected one ARG NODE_IMAGE=…, found 2'],
      [
        'a tag without a digest',
        'ARG NODE_IMAGE=node:22-bookworm-slim\n',
        'is not a node:<tag>@sha256:<digest>',
      ],
      [
        'another image',
        `ARG NODE_IMAGE=evil/node:22@sha256:${'a'.repeat(64)}\n`,
        'is not a node:<tag>@sha256:<digest>',
      ],
      [
        'an option for docker',
        `ARG NODE_IMAGE=--privileged node:22@sha256:${'a'.repeat(64)}\n`,
        'is not a node:<tag>@sha256:<digest>',
      ],
    ])('throws on %s', (_case, dockerfile, message) => {
      expect(() => baseImageOf(dockerfile)).toThrow(message);
    });
  });

  describe('checkImageFiles', () => {
    it('passes when the image is its base plus the copies, owned by node', () => {
      expect(check(listings())).toEqual({
        entries: 15,
        fromBase: 4,
        appFiles: ['/app/package.json'],
        problems: [],
      });
    });

    it('expects the copied entries and the directories made on the way to belong to node', () => {
      const { expected } = expectedFiles(listings(), COPIES);
      expect(expected.get('/app')).toEqual(directory('/app', OWNER));
      expect(expected.get('/app/dist/apps')).toEqual(directory('/app/dist/apps', OWNER));
      expect(expected.get('/app/node_modules/wrangler/package.json')).toMatchObject({
        ...OWNER,
        mode: '755',
      });
      expect(expected.get('/etc/passwd')).toMatchObject(ROOT);
    });

    it('fails on a file the image has that is neither the base image nor a copy', () => {
      const changed = listings();
      changed.runtime.push(file('/app/package-lock.json', 'lock', OWNER), file('/usr/bin/extra', 'x'));
      expect(check(changed).problems).toEqual([
        "/app/package-lock.json: in the image, but neither the base image's nor copied",
        "/usr/bin/extra: in the image, but neither the base image's nor copied",
      ]);
    });

    it('fails when a copied or a base file is missing from the image', () => {
      const changed = listings();
      changed.runtime = without(without(changed.runtime, '/app/package.json'), '/etc/passwd');
      expect(check(changed).problems).toEqual([
        '/app/package.json: missing from the image',
        '/etc/passwd: missing from the image',
      ]);
    });

    it('fails when a file was dropped from the table but is still in the image, and the other way round', () => {
      const [first, ...rest] = COPIES;
      expect(checkImageFiles(listings(), rest).problems).toEqual([
        "/app/package.json: in the image, but neither the base image's nor copied",
      ]);
      const changed = listings();
      changed.runtime = without(changed.runtime, first.path);
      expect(checkImageFiles(changed, rest).problems).toEqual([]);
    });

    it.each([
      [
        'content',
        '/app/dist/apps/api/main.js',
        { sha256: 'sha-of-other' },
        'sha256 sha-of-bundle expected, sha-of-other in the image',
      ],
      ['size', '/app/dist/apps/api/main.js', { size: 7 }, 'size 6 expected, 7 in the image'],
      [
        'mode',
        '/app/node_modules/wrangler/package.json',
        { mode: '4755' },
        'mode 755 expected, 4755 in the image',
      ],
      ['owner', '/app/node_modules/wrangler', ROOT, 'uid 1000 expected, 0 in the image'],
      [
        'link target',
        '/app/node_modules/.bin/wrangler',
        { link: '/bin/sh' },
        'link ../wrangler/bin/wrangler.js expected, /bin/sh in the image',
      ],
      [
        'a base file',
        '/etc/passwd',
        { sha256: 'sha-of-rootkit' },
        'sha256 sha-of-root expected, sha-of-rootkit in the image',
      ],
      ['the owner of /app', '/app', ROOT, 'uid 1000 expected, 0 in the image'],
    ])('fails when %s differs', (_case, path, change, problem) => {
      const changed = listings();
      changed.runtime = replaced(changed.runtime, path, change);
      expect(check(changed).problems).toContain(`${path}: ${problem}`);
    });

    it('fails when a path changed its type', () => {
      const changed = listings();
      changed.runtime = replaced(changed.runtime, '/app/node_modules/wrangler', {
        type: 'link',
        link: '/tmp',
      });
      expect(check(changed).problems).toContain(
        '/app/node_modules/wrangler: type directory expected, link in the image',
      );
    });

    it('fails when a copy is not in its stage, or leaves /app', () => {
      const changed = listings();
      changed.build = [];
      expect(check(changed).problems).toContain('/app/dist/apps/api: not in the build stage');
      expect(checkImageFiles(listings(), [{ stage: 'build', path: '/etc/passwd' }]).problems).toContain(
        '/etc/passwd: a copy outside /app',
      );
    });

    it('fails when the base image already has an /app', () => {
      const changed = listings();
      changed.base.push(directory('/app'));
      expect(check(changed).problems).toContain('/app: already in the base image');
    });

    it('fails on empty listings rather than comparing nothing with nothing', () => {
      const { problems } = checkImageFiles({ base: [], 'runtime-deps': [], build: [], runtime: [] }, []);
      expect(problems).toEqual([
        '/app: missing from the image',
        '/app: the image listing has no /app',
        'the base image listing is empty',
      ]);
    });
  });

  describe('on disk', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'image-files-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('lists files, directories and links with mode, size and sha256, never following a link', () => {
      const outside = mkdtempSync(join(tmpdir(), 'image-files-outside-'));
      try {
        writeFileSync(join(outside, 'secret'), 'secret');
        mkdirSync(join(root, 'tree/sub'), { recursive: true });
        writeFileSync(join(root, 'tree/sub/a.txt'), 'abc');
        chmodSync(join(root, 'tree/sub/a.txt'), 0o640);
        symlinkSync(outside, join(root, 'tree/linked'));
        const entries = listFiles([join(root, 'tree')]);
        expect(entries.map((entry) => [entry.path.slice(root.length), entry.type])).toEqual([
          ['/tree', 'directory'],
          ['/tree/linked', 'link'],
          ['/tree/sub', 'directory'],
          ['/tree/sub/a.txt', 'file'],
        ]);
        expect(entries[1]).toMatchObject({ link: outside });
        expect(entries[2]?.size).toBeUndefined();
        expect(entries[3]).toMatchObject({
          mode: '640',
          size: 3,
          sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
          uid: process.getuid?.(),
        });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('leaves out the skipped paths, and lists a directory it must not enter without its content', () => {
      mkdirSync(join(root, 'proc'));
      writeFileSync(join(root, 'proc/1'), '');
      writeFileSync(join(root, 'hosts'), '');
      writeFileSync(join(root, 'kept'), '');
      const entries = listFiles([root], {
        skip: new Set([join(root, 'hosts')]),
        notEntered: new Set([join(root, 'proc')]),
      });
      expect(entries.map((entry) => entry.path.slice(root.length))).toEqual(['', '/kept', '/proc']);
    });

    function run(args: string[]) {
      return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
    }

    function writeListings(written: Listings): void {
      for (const [stage, entries] of Object.entries(written)) {
        writeFileSync(
          join(root, `${stage}.jsonl`),
          entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        );
      }
    }

    /** The real table of copies, each copy a single file, on a one-directory base. */
    function realListings(): Listings {
      const copied = (stage: string) =>
        RUNTIME_COPIES.filter((copy) => copy.stage === stage).map((copy) => file(copy.path, copy.path));
      const base = [directory('/')];
      const { expected } = expectedFiles({
        base,
        'runtime-deps': copied('runtime-deps'),
        build: copied('build'),
      });
      return {
        base,
        'runtime-deps': copied('runtime-deps'),
        build: copied('build'),
        runtime: [...expected.values()],
      };
    }

    it('check exits 0 and prints the files of /app a reader can check by eye', () => {
      writeListings(realListings());
      const result = run(['check', root]);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('under /app, outside node_modules and dist:\n');
      expect(result.stdout).toContain('/app/package.json\n');
      expect(result.stdout).toContain(
        "the runtime image is the expected file list: 14 paths, 1 of them the base image's",
      );
      expect(result.status).toBe(0);
    });

    it('check exits 1 and names the path when the image has a file too many', () => {
      const changed = realListings();
      changed.runtime.push(file('/app/extra.js', 'x', OWNER));
      writeListings(changed);
      const result = run(['check', root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the runtime image is not the expected file list (1 problems):');
      expect(result.stderr).toContain("/app/extra.js: in the image, but neither the base image's nor copied");
    });

    it('check exits 2 when a listing is missing or is not JSON lines', () => {
      expect(run(['check', root]).status).toBe(2);
      writeListings(realListings());
      writeFileSync(join(root, 'build.jsonl'), 'not json\n');
      const result = run(['check', root]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('cannot check the image files: ');
    });

    it('base-image prints the pinned image, and exits 2 on a Dockerfile without one', () => {
      writeFileSync(
        join(root, 'Dockerfile'),
        `ARG NODE_IMAGE=node:22-slim@sha256:${'0'.repeat(64)}\nFROM x\n`,
      );
      const result = run(['base-image', join(root, 'Dockerfile')]);
      expect(result.stdout).toBe(`node:22-slim@sha256:${'0'.repeat(64)}\n`);
      expect(result.status).toBe(0);
      writeFileSync(join(root, 'Dockerfile'), 'FROM node:22\n');
      const unpinned = run(['base-image', join(root, 'Dockerfile')]);
      expect(unpinned.status).toBe(2);
      expect(unpinned.stdout).toBe('');
    });

    it.each([[[]], [['list']], [['list', 'elsewhere']], [['check', 'a', 'b']], [['push', 'x']]])(
      'exits 2 on the arguments %j',
      (args) => {
        const result = run(args);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
      },
    );

    it('fails rather than exit 0 when it is not started as a file', () => {
      const piped = spawnSync(process.execPath, ['--input-type=module'], {
        input: readFileSync(SCRIPT, 'utf8'),
        encoding: 'utf8',
      });
      expect(piped.status).not.toBe(0);
      expect(piped.stderr).toContain('image-files.mjs must be started as a file');
    });
  });
});
