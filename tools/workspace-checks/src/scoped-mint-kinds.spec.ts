import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * #759 (security note, PR 1; threat model C5 row 2, R8): the console app's one-repository write tokens are named
 * kinds, and each kind may be asked for by one reviewed module only. Nothing else in the Worker code can obtain
 * `workflows: write`: the permission exists in one frozen constant, the only mint is `GitHubAppAuth`'s, and every
 * `mintScoped` call names its kind as a literal from a module on the list below. A new caller (a readiness route, the
 * workflow-PR route, a Phase 3 job token) changes this list, so the change is visible and reviewed with the security
 * label.
 */

const SCOPED_KINDS = ['actions-dispatch', 'environment-read', 'workflow-pr'] as const;
type ScopedKind = (typeof SCOPED_KINDS)[number];

/** The modules that may name each kind. Empty means no module may mint it yet (#759 PRs 3 and 4 add theirs). */
const ALLOWED_CALLERS: Readonly<Record<ScopedKind, readonly string[]>> = {
  'actions-dispatch': ['apps/api/src/actions/dispatch.ts'],
  'environment-read': [],
  'workflow-pr': [],
};

const APP_AUTH = 'libs/worker/github/src/lib/app-auth.ts';
const SCOPED_MINT = 'libs/worker/github/src/lib/scoped-mint.ts';
const MOCK = 'libs/worker/github/src/lib/mock.ts';
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.angular', '.nx', 'coverage']);

function sourcesUnder(relativeDir: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      if (SKIPPED_DIRS.has(entry)) {
        return [];
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return walk(full);
      }
      return entry.endsWith('.ts') && !entry.endsWith('.d.ts') ? [relative(workspaceRoot, full)] : [];
    });
  return walk(join(workspaceRoot, relativeDir));
}

/** Worker, runner and console code that ships: specs, test kits and the mock GitHub are not callers. */
const isShippedSource = (file: string): boolean =>
  !/\.(spec|test|integration\.spec)\.ts$/.test(file) && !file.includes('/testing/') && file !== MOCK;

const SOURCES = [...sourcesUnder('apps'), ...sourcesUnder('libs')].filter(isShippedSource);

function parsed(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(workspaceRoot, file), 'utf8'), ts.ScriptTarget.ES2022, true);
}

function callsNamed(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

interface MintCall {
  readonly file: string;
  /** The literal kind, or the source text of a non-literal first argument. */
  readonly kind: string;
  readonly isLiteral: boolean;
}

const MINT_CALLS: readonly MintCall[] = SOURCES.flatMap((file) => {
  const source = parsed(file);
  return callsNamed(source, 'mintScoped').map((call) => {
    const [first] = call.arguments;
    const isLiteral = first !== undefined && ts.isStringLiteralLike(first);
    return { file, kind: isLiteral ? first.text : (first?.getText(source) ?? ''), isLiteral };
  });
});

describe('named scoped mints (#759, threat model C5 R8)', () => {
  it('finds the dispatch call, so the scan reads the sources it is meant to', () => {
    expect(MINT_CALLS).toContainEqual({ file: 'apps/api/src/actions/dispatch.ts', kind: 'actions-dispatch', isLiteral: true });
  });

  it('names every scoped kind as a string literal, never through a variable', () => {
    expect(MINT_CALLS.filter((call) => !call.isLiteral)).toEqual([]);
  });

  it('names only the known kinds', () => {
    const known: readonly string[] = SCOPED_KINDS;
    expect(MINT_CALLS.filter((call) => !known.includes(call.kind))).toEqual([]);
  });

  it.each(SCOPED_KINDS)('lets only the listed modules mint a %s token', (kind) => {
    const callers = [...new Set(MINT_CALLS.filter((call) => call.kind === kind).map((call) => call.file))].sort();
    expect(callers).toEqual([...ALLOWED_CALLERS[kind]].sort());
  });

  it('keeps the scoped kinds of this spec equal to the library’s', () => {
    const text = readFileSync(join(workspaceRoot, SCOPED_MINT), 'utf8');
    const declared = /SCOPED_MINT_KINDS = \[([^\]]*)\] as const/.exec(text)?.[1] ?? '';
    expect(declared.split(',').map((kind) => kind.trim().replace(/^'|'$/g, '')).filter(Boolean)).toEqual([
      ...SCOPED_KINDS,
    ]);
  });

  it('holds workflows: write in one constant of the library and nowhere else', () => {
    const holders = SOURCES.filter((file) =>
      /\bworkflows['"]?\s*:\s*['"]write['"]/.test(readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    expect(holders).toEqual([SCOPED_MINT]);
  });

  it('mints installation tokens in GitHubAppAuth alone', () => {
    const minters = SOURCES.filter((file) => readFileSync(join(workspaceRoot, file), 'utf8').includes('access_tokens'));
    expect(minters).toEqual([APP_AUTH]);
  });

  it('passes every this.mint( a permission set drawn from the named constants', () => {
    const source = parsed(APP_AUTH);
    const calls = callsNamed(source, 'mint').filter((call) => call.expression.getText(source) === 'this.mint');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const permissionsOf = (call: ts.CallExpression): string => {
      const body = call.arguments[1];
      if (body === undefined || !ts.isObjectLiteralExpression(body)) {
        return `not an object literal: ${body?.getText(source) ?? 'none'}`;
      }
      const member = body.properties.find((property) => property.name?.getText(source) === 'permissions');
      if (member === undefined) {
        return 'no permissions member';
      }
      return ts.isShorthandPropertyAssignment(member)
        ? member.name.text
        : ts.isPropertyAssignment(member)
          ? member.initializer.getText(source)
          : member.getText(source);
    };
    const used = calls.map(permissionsOf);
    expect(used.every((value) => ['INSTALLATION_PERMISSIONS', 'INSTALLATION_LIST_PERMISSIONS', 'permissions'].includes(value)), used.join(', ')).toBe(true);
    // The one shorthand `permissions` is the named kind's frozen set, never a parameter.
    expect(source.getFullText().match(/const permissions = [^;]+;/g)).toEqual([
      'const permissions = SCOPED_MINT_PERMISSIONS[kind];',
    ]);
  });
});
