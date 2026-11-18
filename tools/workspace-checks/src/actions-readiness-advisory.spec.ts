import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * #759 PR 3 (security note row "Readiness used as authorisation"): the Actions readiness check is availability only.
 * It holds back the owner's switch to `actions`, and nothing else reads it: the OIDC exchange, the dispatch and the
 * sweep keep their own checks (`ref`, `workflow_ref`, `environment`, `repository_id`, `runner_environment`) and never
 * relax one because readiness said ok. This spec pins who may import the check and its answer's helpers.
 */

const API_SRC = 'apps/api/src';
const READINESS_MODULE = `${API_SRC}/actions/readiness.ts`;
/** The only modules that may run the check: the readiness route and the switch. */
const READINESS_CALLERS: readonly string[] = [`${API_SRC}/routes/actions-setup.ts`, `${API_SRC}/routes/project-dispatch.ts`];
/** The readiness answer's helpers from `@shared/contracts`; the exchange path must not judge anything by them. */
const READINESS_NAMES: ReadonlySet<string> = new Set([
  'checkActionsReadiness',
  'readinessTargetOf',
  'blockingItemsOf',
  'isActionsSetupDto',
  'ACTIONS_SETUP_ITEMS',
  'ACTIONS_SETUP_ADVISORY_ITEMS',
  'ActionsSetupDto',
  'ActionsReadinessTarget',
]);
/** The run-time path of an Actions job: exchange, dispatch, sweep and the runner's own routes. */
const EXCHANGE_PATH: readonly string[] = [
  `${API_SRC}/auth/actions-oidc.ts`,
  `${API_SRC}/routes/runner-oidc.ts`,
  `${API_SRC}/routes/runner-jobs.ts`,
  `${API_SRC}/actions/dispatch.ts`,
  `${API_SRC}/actions/sweep.ts`,
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'coverage']);

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

const isShipped = (file: string): boolean => !/\.spec\.ts$/.test(file) && !file.includes('/testing/');
const SOURCES = [...sourcesUnder('apps'), ...sourcesUnder('libs')].filter(isShipped);

interface Imports {
  /** Value imports only: a type-only import runs nothing. */
  readonly specifiers: readonly string[];
  readonly names: readonly string[];
}

function importsOf(file: string): Imports {
  const source = ts.createSourceFile(file, readFileSync(join(workspaceRoot, file), 'utf8'), ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.importClause?.isTypeOnly !== true) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      names.push(...bindings.elements.map((element) => (element.propertyName ?? element.name).text));
    }
  }
  return { specifiers, names };
}

const importsReadiness = (file: string): boolean =>
  importsOf(file).specifiers.some((specifier) => /(^|\/)actions\/readiness$|^\.\/readiness$/.test(specifier));

describe('the Actions readiness check is advisory (#759, ADR 0008 R8)', () => {
  it('finds the readiness module and its callers, so the scan reads the sources it is meant to', () => {
    expect(SOURCES).toContain(READINESS_MODULE);
    for (const caller of READINESS_CALLERS) {
      expect(importsReadiness(caller)).toBe(true);
    }
  });

  it('is run only by the readiness route and the switch', () => {
    expect(SOURCES.filter((file) => file !== READINESS_MODULE && importsReadiness(file))).toEqual([...READINESS_CALLERS]);
  });

  it.each(EXCHANGE_PATH)('%s never reads readiness', (file) => {
    expect(SOURCES).toContain(file);
    const imports = importsOf(file);
    expect(importsReadiness(file)).toBe(false);
    expect(imports.names.filter((name) => READINESS_NAMES.has(name))).toEqual([]);
  });
});
