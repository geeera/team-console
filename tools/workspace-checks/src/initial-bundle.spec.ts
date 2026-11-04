import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * What keeps the console's initial bundle under its 500 kB warning budget (#123).
 *
 * With code splitting, esbuild assigns modules to chunks by file reachability: a barrel line
 * `export { X } from './x'` makes `./x` part of the chunk of anyone who imports the barrel, used or not, so a lib
 * the app shell imports eagerly dragged every lazy page's kit primitives, the setup checklist and the CDK dialog into
 * `main`. A barrel made only of `export * from` lines, in a workspace whose sources are declared free of side effects,
 * is resolved name by name instead. These guards keep both halves in place; the build budget itself is the last one.
 */

function read(path: string): string {
  return readFileSync(join(workspaceRoot, path), 'utf8');
}

/** The barrels the shell reaches on the eager path that hold modules only lazy pages use. */
const STAR_ONLY_BARRELS = [
  'libs/console/shared/ui/src/index.ts',
  'libs/console/entities/project/src/index.ts',
  'libs/console/entities/push/src/index.ts',
];

/** Shipped sources: every `src/` under apps/ and libs/, without specs, stories, e2e specs and test setup. */
function shippedSources(): string[] {
  const skipped = /(\.spec|\.e2e|\.stories)\.ts$|(^|\/)test-setup\.ts$/;
  const walk = (dir: string, inSrc: boolean): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name.startsWith('.')
          ? []
          : walk(full, inSrc || entry.name === 'src');
      }
      const path = relative(workspaceRoot, full);
      return inSrc && path.endsWith('.ts') && !skipped.test(path) ? [path] : [];
    });
  return ['apps', 'libs'].flatMap((root) => walk(join(workspaceRoot, root), false));
}

const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm;

describe('initial bundle (#123)', () => {
  it('declares the workspace sources free of side effects except stylesheets', () => {
    const pkg: unknown = JSON.parse(read('package.json'));

    expect(pkg).toMatchObject({ sideEffects: ['*.css'] });
  });

  // `sideEffects: ["*.css"]` lets the bundler drop any module none of whose exports is used, and a bare
  // `import 'x'` uses none: a polyfill, guard or interceptor registered that way would silently vanish from the build.
  it('has no bare side-effect import in shipped sources, stylesheets aside', () => {
    const sources = shippedSources();
    const bare = sources.flatMap((path) =>
      [...read(path).matchAll(BARE_IMPORT)]
        .map((match) => match[1] ?? '')
        .filter((specifier) => !specifier.endsWith('.css'))
        .map((specifier) => `${path}: import '${specifier}'`),
    );

    expect(sources.length).toBeGreaterThan(100);
    expect(bare).toEqual([]);
  });

  it.each(STAR_ONLY_BARRELS)('%s re-exports whole files only', (barrel) => {
    const statements = read(barrel)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'));

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^export \* from '\.\/[\w./-]+';$/);
    }
  });

  it('keeps the 500 kB initial and 4 kB per-component style warning budgets', () => {
    const project: unknown = JSON.parse(read('apps/console/project.json'));

    expect(project).toMatchObject({
      targets: {
        build: {
          configurations: {
            production: {
              budgets: expect.arrayContaining([
                expect.objectContaining({ type: 'initial', maximumWarning: '500kb' }),
                expect.objectContaining({ type: 'anyComponentStyle', maximumWarning: '4kb' }),
              ]),
            },
          },
        },
      },
    });
  });
});
