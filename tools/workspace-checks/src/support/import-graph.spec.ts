import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { aliasTargets, reachableFrom, type Aliases } from './import-graph';

/**
 * #983: the walk read only exact `paths` keys, so `@shared/*` style aliases resolved to "a package outside the
 * workspace" and everything behind them left the walk silently — in ci-scope.spec.ts that is a library the macOS
 * sweep depends on and its scope pattern does not name; in hooks-isolation.spec.ts the app auth in the hooks bundle.
 */

const ALIASES: Aliases = {
  '@shared/contracts': ['./libs/shared/contracts/src/index.ts'],
  '@shared/*': ['./libs/shared/*/src/index.ts'],
  '@shared/deep/*': ['./libs/deep/*'],
  '@gen/*.types': ['./generated/missing/*.ts', './generated/*.ts'],
  '@gone/*': ['./nowhere/*'],
};

describe('aliasTargets', () => {
  it('prefers an exact key to a wildcard that also matches', () => {
    expect(aliasTargets(ALIASES, '@shared/contracts')).toEqual(['./libs/shared/contracts/src/index.ts']);
  });

  it('substitutes what the wildcard stood for', () => {
    expect(aliasTargets(ALIASES, '@shared/plain-text')).toEqual(['./libs/shared/plain-text/src/index.ts']);
    expect(aliasTargets(ALIASES, '@gen/api.types')).toEqual([
      './generated/missing/api.ts',
      './generated/api.ts',
    ]);
  });

  it('picks the wildcard key with the longest prefix', () => {
    expect(aliasTargets(ALIASES, '@shared/deep/x/y')).toEqual(['./libs/deep/x/y']);
  });

  it('keeps replacement patterns in the matched text literal', () => {
    expect(aliasTargets(ALIASES, '@shared/$&')).toEqual(['./libs/shared/$&/src/index.ts']);
  });

  it.each(['rxjs', '@sharedx/a', '@gen/api', '@gen/.type', 'constructor', '__proto__', ''])(
    'gives null for %j, which no key matches',
    (specifier) => {
      expect(aliasTargets(ALIASES, specifier)).toBeNull();
    },
  );
});

describe('reachableFrom', () => {
  let root: string;
  const write = (file: string, source: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'import-graph-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('follows wildcard aliases, to a file, a bare path and the first target that exists', () => {
    write(
      'apps/a/src/main.ts',
      [
        `import { plain } from '@shared/plain-text';`,
        `import type { Api } from '@gen/api.types';`,
        `export { deep } from '@shared/deep/x';`,
        `import { of } from 'rxjs';`,
        `import data from './data.json';`,
        `void import('./lazy');`,
      ].join('\n'),
    );
    write('apps/a/src/data.json', '{}');
    write('apps/a/src/lazy.ts', `import '@shared/contracts';`);
    write('libs/shared/plain-text/src/index.ts', `export * from './lib/plain';`);
    write('libs/shared/plain-text/src/lib/plain.ts', 'export const plain = 1;');
    write('libs/shared/contracts/src/index.ts', 'export const c = 1;');
    write('libs/deep/x/index.ts', 'export const deep = 1;');
    write('generated/api.ts', 'export type Api = 1;');

    const reached = reachableFrom('apps/a/src/main.ts', { root, aliases: ALIASES });

    expect([...reached.keys()].sort()).toEqual([
      'apps/a/src/data.json',
      'apps/a/src/lazy.ts',
      'apps/a/src/main.ts',
      'generated/api.ts',
      'libs/deep/x/index.ts',
      'libs/shared/contracts/src/index.ts',
      'libs/shared/plain-text/src/index.ts',
      'libs/shared/plain-text/src/lib/plain.ts',
    ]);
    expect(reached.get('libs/shared/plain-text/src/lib/plain.ts')).toBe(
      'libs/shared/plain-text/src/index.ts',
    );
  });

  // #992: a `.tsx` or `.mts` file was listed and never read, so whatever it imported left the walk unseen.
  it.each(['tsx', 'mts', 'cts', 'mjs'])('reads the imports of a .%s file it reaches', (extension) => {
    write('apps/a/src/main.ts', `import './view.${extension}';`);
    write(`apps/a/src/view.${extension}`, `import { plain } from '@shared/plain-text';\nvoid plain;`);
    write('libs/shared/plain-text/src/index.ts', 'export const plain = 1;');

    const reached = reachableFrom('apps/a/src/main.ts', { root, aliases: ALIASES });

    expect(reached.get('libs/shared/plain-text/src/index.ts')).toBe(`apps/a/src/view.${extension}`);
  });

  it('starts from a .mts entry and finds a .tsx file behind an import without an extension', () => {
    write(
      'apps/a/vite.config.mts',
      `import { View } from './src/view';\nimport './src/widgets';\nvoid View;`,
    );
    write('apps/a/src/view.tsx', `import '@shared/contracts';\nexport const View = () => <p />;`);
    write('apps/a/src/widgets/index.tsx', 'export const Widget = () => <p />;');
    write('libs/shared/contracts/src/index.ts', 'export const c = 1;');

    const reached = reachableFrom('apps/a/vite.config.mts', { root, aliases: ALIASES });

    expect([...reached.keys()].sort()).toEqual([
      'apps/a/src/view.tsx',
      'apps/a/src/widgets/index.tsx',
      'apps/a/vite.config.mts',
      'libs/shared/contracts/src/index.ts',
    ]);
  });

  // #999: only index.ts / index.tsx were tried, so a directory whose index is .mts or .cts did not resolve.
  it.each(['mts', 'cts'])('finds index.%s behind a directory import and reads its imports', (extension) => {
    write('apps/a/src/main.ts', `import './widgets';\nimport '@shared/deep/x';`);
    write(`apps/a/src/widgets/index.${extension}`, `import '@shared/contracts';`);
    write(`libs/deep/x/index.${extension}`, `import './lib/deep';`);
    write('libs/deep/x/lib/deep.ts', 'export const deep = 1;');
    write('libs/shared/contracts/src/index.ts', 'export const c = 1;');

    const reached = reachableFrom('apps/a/src/main.ts', { root, aliases: ALIASES });

    expect([...reached.keys()].sort()).toEqual([
      'apps/a/src/main.ts',
      `apps/a/src/widgets/index.${extension}`,
      `libs/deep/x/index.${extension}`,
      'libs/deep/x/lib/deep.ts',
      'libs/shared/contracts/src/index.ts',
    ]);
    expect(reached.get('libs/shared/contracts/src/index.ts')).toBe(`apps/a/src/widgets/index.${extension}`);
  });

  it('prefers index.ts, then index.tsx, to index.mts and index.cts in the same directory', () => {
    write('apps/a/src/main.ts', `import './both';\nimport './modules';\nimport './views';`);
    write('apps/a/src/both/index.ts', 'export const both = 1;');
    write('apps/a/src/both/index.mts', 'export const both = 2;');
    write('apps/a/src/views/index.tsx', 'export const View = () => <p />;');
    write('apps/a/src/views/index.cts', 'export const view = 1;');
    write('apps/a/src/modules/index.mts', 'export const m = 1;');
    write('apps/a/src/modules/index.cts', 'export const m = 2;');

    const reached = reachableFrom('apps/a/src/main.ts', { root, aliases: {} });

    expect([...reached.keys()].sort()).toEqual([
      'apps/a/src/both/index.ts',
      'apps/a/src/main.ts',
      'apps/a/src/modules/index.mts',
      'apps/a/src/views/index.tsx',
    ]);
  });

  it('prefers a file to a directory of the same name, and still throws for a directory without an index', () => {
    write('apps/a/src/main.ts', `import './widgets';`);
    write('apps/a/src/widgets.ts', 'export const w = 1;');
    write('apps/a/src/widgets/index.mts', 'export const w = 2;');
    expect([...reachableFrom('apps/a/src/main.ts', { root, aliases: {} }).keys()].sort()).toEqual([
      'apps/a/src/main.ts',
      'apps/a/src/widgets.ts',
    ]);

    write('apps/a/src/other.ts', `import './empty';`);
    write('apps/a/src/empty/readme.md', '');
    expect(() => reachableFrom('apps/a/src/other.ts', { root, aliases: {} })).toThrow(
      'apps/a/src/other.ts: cannot resolve ./empty',
    );
  });

  it('reads an import of the emitted .js/.mjs name as the source file next to it', () => {
    write(
      'apps/a/src/main.mts',
      [`import './worker.mjs';`, `import './util.js';`, `import './view.js';`, `import './real.mjs';`].join(
        '\n',
      ),
    );
    write('apps/a/src/worker.mts', `import '@shared/contracts';`);
    write('apps/a/src/util.ts', 'export const util = 1;');
    write('apps/a/src/view.tsx', 'export const View = () => <p />;');
    write('apps/a/src/real.mjs', `import '@shared/plain-text';`);
    write('libs/shared/contracts/src/index.ts', 'export const c = 1;');
    write('libs/shared/plain-text/src/index.ts', 'export const plain = 1;');

    const reached = reachableFrom('apps/a/src/main.mts', { root, aliases: ALIASES });

    expect([...reached.keys()].sort()).toEqual([
      'apps/a/src/main.mts',
      'apps/a/src/real.mjs',
      'apps/a/src/util.ts',
      'apps/a/src/view.tsx',
      'apps/a/src/worker.mts',
      'libs/shared/contracts/src/index.ts',
      'libs/shared/plain-text/src/index.ts',
    ]);
  });

  it('prefers the source file to an emitted file of the same name', () => {
    write('apps/a/src/main.ts', `import './util.js';`);
    write('apps/a/src/util.ts', 'export const util = 1;');
    write('apps/a/src/util.js', 'exports.util = 1;');

    const reached = reachableFrom('apps/a/src/main.ts', { root, aliases: {} });

    expect([...reached.keys()].sort()).toEqual(['apps/a/src/main.ts', 'apps/a/src/util.ts']);
  });

  it('leaves a file that is not source unread', () => {
    write('apps/a/src/main.ts', `import './data.json';\nimport './style.css';`);
    write('apps/a/src/data.json', `{ "import": "./missing" }`);
    write('apps/a/src/style.css', `@import './missing.css';`);

    const reached = reachableFrom('apps/a/src/main.ts', { root, aliases: {} });

    expect([...reached.keys()].sort()).toEqual([
      'apps/a/src/data.json',
      'apps/a/src/main.ts',
      'apps/a/src/style.css',
    ]);
  });

  it('throws when an alias matches and none of its targets exists', () => {
    write('apps/a/src/main.ts', `import '@gone/lib';`);
    expect(() => reachableFrom('apps/a/src/main.ts', { root, aliases: ALIASES })).toThrow(
      'apps/a/src/main.ts: alias @gone/lib matches tsconfig paths but none of its targets exists',
    );
  });

  it('throws when a relative import leads nowhere', () => {
    write('apps/a/src/main.ts', `import './missing';`);
    expect(() => reachableFrom('apps/a/src/main.ts', { root, aliases: {} })).toThrow(
      'apps/a/src/main.ts: cannot resolve ./missing',
    );
  });
});
