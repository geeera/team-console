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
