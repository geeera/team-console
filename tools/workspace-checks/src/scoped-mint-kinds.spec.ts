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

/** The modules that may name each kind: one reviewed caller per kind. */
const ALLOWED_CALLERS: Readonly<Record<ScopedKind, readonly string[]>> = {
  'actions-dispatch': ['apps/api/src/actions/dispatch.ts'],
  // #759 PR 3: the readiness check, behind `GET …/actions-setup` and the switch `PUT …/dispatch {actions}`.
  'environment-read': ['apps/api/src/actions/readiness.ts'],
  // #759 PR 4: the workflow pull request, behind `POST …/actions-setup/workflow-pr` on the account owner's click.
  'workflow-pr': ['apps/api/src/actions/workflow-pr.ts'],
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
  return ts.createSourceFile(
    file,
    readFileSync(join(workspaceRoot, file), 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
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

/** The modules besides the callers that may write a kind as a literal: the library and its token-taking helpers. */
const KIND_LITERAL_HOLDERS: Readonly<Record<ScopedKind, readonly string[]>> = {
  'actions-dispatch': [APP_AUTH, SCOPED_MINT, 'libs/worker/github/src/lib/actions-dispatch.ts'],
  'environment-read': [APP_AUTH, SCOPED_MINT, 'libs/worker/github/src/lib/actions-setup-reads.ts'],
  'workflow-pr': [APP_AUTH, SCOPED_MINT, 'libs/worker/github/src/lib/actions-setup-writes.ts'],
};
const CALLER_FILES: ReadonlySet<string> = new Set(Object.values(ALLOWED_CALLERS).flat());

/**
 * Names that hold a kind's letters without being one: the route's path segment and the audit events of #759 PR 4.
 * They are taken out of a text before it is searched, so `'workflow-pr'` on its own, or built from pieces, is still
 * found in the same file.
 */
const NOT_A_KIND = /\/actions-setup\/workflow-pr\b|\bactions-workflow-pr-(?:attempted|opened|failed)\b/g;

/** The string a literal, a template or a `+` of them spells, or `null` when any part is not constant. */
function constantText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text];
    for (const span of node.templateSpans) {
      const value = constantText(span.expression);
      if (value === null) {
        return null;
      }
      parts.push(value, span.literal.text);
    }
    return parts.join('');
  }
  if (ts.isParenthesizedExpression(node)) {
    return constantText(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(node.left);
    const right = constantText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

interface Mention {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** A direct `<receiver>.mintScoped(<literal>, …)` call: the one shape a caller may use. */
function isDirectMintCallee(node: ts.Identifier): boolean {
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node) {
    return false;
  }
  const call = access.parent;
  const [first] = ts.isCallExpression(call) && call.expression === access ? call.arguments : [];
  return first !== undefined && ts.isStringLiteralLike(first);
}

/**
 * SEC 1 of PR 1's review: every way to name the mint or a kind that is not the reviewed shape — element access
 * (`auth['mintScoped']`, a template key), `.bind`, destructuring, a stored reference, a kind built from pieces.
 */
const ALIAS_FINDINGS: { readonly names: Mention[]; readonly kinds: Mention[] } = (() => {
  const names: Mention[] = [];
  const kinds: Mention[] = [];
  for (const file of SOURCES) {
    const source = parsed(file);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'mintScoped') {
        const isDeclaration =
          file === APP_AUTH && ts.isMethodDeclaration(node.parent) && node.parent.name === node;
        const isCall = CALLER_FILES.has(file) && isDirectMintCallee(node);
        if (!isDeclaration && !isCall) {
          names.push({ file, line: lineOf(source, node), text: node.parent.getText(source) });
        }
      }
      const parent = node.parent as ts.Node | undefined;
      const isModuleSpecifier =
        parent !== undefined &&
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        parent.moduleSpecifier === node;
      const text =
        !isModuleSpecifier &&
        (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node))
          ? constantText(node)
          : null;
      // A `+` is judged once, as a whole; its leaves are visited too, and a bare kind leaf is caught there.
      if (text !== null) {
        if (text.includes('mintScoped')) {
          names.push({ file, line: lineOf(source, node), text });
        }
        for (const kind of SCOPED_KINDS) {
          const mayHold = KIND_LITERAL_HOLDERS[kind].includes(file) || ALLOWED_CALLERS[kind].includes(file);
          if (text.replace(NOT_A_KIND, '').includes(kind) && !mayHold) {
            kinds.push({ file, line: lineOf(source, node), text });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { names, kinds };
})();

describe('no alias reaches a scoped mint (#759 SEC 1)', () => {
  it('names mintScoped only as its declaration and as direct calls with a literal kind in the allowed callers', () => {
    expect(ALIAS_FINDINGS.names).toEqual([]);
  });

  it('writes a kind only in the library, its token-taking helpers and the allowed callers of that kind', () => {
    expect(ALIAS_FINDINGS.kinds).toEqual([]);
  });

  it('takes the route path and the audit event names for what they are, and still finds a kind beside them', () => {
    const strip = (text: string): string => text.replace(NOT_A_KIND, '');
    expect(strip('POST /api/v1/projects/:slug/actions-setup/workflow-pr')).not.toContain('workflow-pr');
    expect(strip('project.actions-workflow-pr-attempted')).not.toContain('workflow-pr');
    expect(strip('workflow-pr')).toBe('workflow-pr');
    expect(strip('/actions-setup/workflow-pr workflow-pr')).toContain('workflow-pr');
    expect(strip('actions-workflow-pr-minted')).toContain('workflow-pr');
  });

  it('would catch element access, .bind, destructuring, template keys and kinds built from pieces', () => {
    const probe = ts.createSourceFile(
      'probe.ts',
      [
        "auth['mintScoped']('workflow-pr', target, audit);",
        'auth[`mintScoped`](kind, target, audit);',
        'const mint = auth.mintScoped.bind(auth);',
        'const { mintScoped } = auth;',
        "auth['mint' + 'Scoped'];",
        "const kind = 'workflow' + '-pr';",
        "const other = `environment-${'read'}`;",
      ].join('\n'),
      ts.ScriptTarget.ES2022,
      true,
    );
    const identifiers: string[] = [];
    const texts: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'mintScoped' && !isDirectMintCallee(node)) {
        identifiers.push(node.parent.getText(probe));
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
        const text = constantText(node);
        if (
          text !== null &&
          (text.includes('mintScoped') || SCOPED_KINDS.some((kind) => text.includes(kind)))
        ) {
          texts.push(text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(identifiers).toEqual(['auth.mintScoped', 'mintScoped']);
    expect(texts).toEqual(expect.arrayContaining(['mintScoped', 'workflow-pr', 'environment-read']));
    expect(texts.filter((text) => text === 'mintScoped')).toHaveLength(3);
  });
});

describe('named scoped mints (#759, threat model C5 R8)', () => {
  it('finds the dispatch call, so the scan reads the sources it is meant to', () => {
    expect(MINT_CALLS).toContainEqual({
      file: 'apps/api/src/actions/dispatch.ts',
      kind: 'actions-dispatch',
      isLiteral: true,
    });
  });

  it('names every scoped kind as a string literal, never through a variable', () => {
    expect(MINT_CALLS.filter((call) => !call.isLiteral)).toEqual([]);
  });

  it('names only the known kinds', () => {
    const known: readonly string[] = SCOPED_KINDS;
    expect(MINT_CALLS.filter((call) => !known.includes(call.kind))).toEqual([]);
  });

  it.each(SCOPED_KINDS)('lets only the listed modules mint a %s token', (kind) => {
    const callers = [
      ...new Set(MINT_CALLS.filter((call) => call.kind === kind).map((call) => call.file)),
    ].sort();
    expect(callers).toEqual([...ALLOWED_CALLERS[kind]].sort());
  });

  it('keeps the scoped kinds of this spec equal to the library’s', () => {
    const text = readFileSync(join(workspaceRoot, SCOPED_MINT), 'utf8');
    const declared = /SCOPED_MINT_KINDS = \[([^\]]*)\] as const/.exec(text)?.[1] ?? '';
    expect(
      declared
        .split(',')
        .map((kind) => kind.trim().replace(/^'|'$/g, ''))
        .filter(Boolean),
    ).toEqual([...SCOPED_KINDS]);
  });

  it('holds workflows: write in one constant of the library and nowhere else', () => {
    const holders = SOURCES.filter((file) =>
      /\bworkflows['"]?\s*:\s*['"]write['"]/.test(readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    expect(holders).toEqual([SCOPED_MINT]);
  });

  it('mints installation tokens in GitHubAppAuth alone', () => {
    const minters = SOURCES.filter((file) =>
      readFileSync(join(workspaceRoot, file), 'utf8').includes('access_tokens'),
    );
    expect(minters).toEqual([APP_AUTH]);
  });

  it('passes every this.mint( a permission set drawn from the named constants', () => {
    const source = parsed(APP_AUTH);
    const calls = callsNamed(source, 'mint').filter(
      (call) => call.expression.getText(source) === 'this.mint',
    );
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
    expect(
      used.every((value) =>
        ['INSTALLATION_PERMISSIONS', 'INSTALLATION_LIST_PERMISSIONS', 'permissions'].includes(value),
      ),
      used.join(', '),
    ).toBe(true);
    // The one shorthand `permissions` is the named kind's frozen set, never a parameter.
    expect(source.getFullText().match(/const permissions = [^;]+;/g)).toEqual([
      'const permissions = SCOPED_MINT_PERMISSIONS[kind];',
    ]);
  });
});
