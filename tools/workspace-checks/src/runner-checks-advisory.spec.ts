import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * #1059 S8 (security note T11, "a passed check is treated as proof or authorisation"): a runner check is advisory. A
 * runner can always report a fake pass, which only misleads its own owner, as long as nothing admits a runner,
 * relaxes placement or marks it verified because of one. This spec pins who touches `runner_checks`: its repository
 * alone holds SQL naming it, and only the check routes, the claim handler's delivery and the revoke batch use that
 * repository (the deletion paths are 0049's own triggers). The claim SQL, placement and the `jobs` repos never do.
 */

const API_SRC = 'apps/api/src';
const DB_SRC = 'libs/worker/db/src';
const REPO = `${DB_SRC}/lib/runners/runner-checks.repo.ts`;
const REPO_NAME = 'RunnerChecksRepo';
const TABLE = 'runner_checks';
/** The repository's callers: the three check routes, the claim's delivery, the revoke's batch. */
const REPO_CALLERS: readonly string[] = [
  `${API_SRC}/routes/account-runners.ts`,
  `${API_SRC}/routes/runner-checks.ts`,
  `${API_SRC}/routes/runner-jobs.ts`,
];
/** The `jobs` pipeline: claim, admission, placement, finish, streak, budget, dispatch. */
const JOB_PATH: readonly string[] = [
  `${DB_SRC}/lib/jobs/jobs.repo.ts`,
  `${DB_SRC}/lib/jobs/team-state.repo.ts`,
  `${DB_SRC}/lib/jobs/project-dispatch.repo.ts`,
  `${DB_SRC}/lib/jobs/orchestration.repo.ts`,
  `${DB_SRC}/lib/team-config/claim-admission.ts`,
  `${DB_SRC}/lib/team-config/access-source.ts`,
  `${API_SRC}/routes/jobs.ts`,
  `${API_SRC}/actions/dispatch.ts`,
  `${API_SRC}/actions/sweep.ts`,
];
const MIGRATIONS = 'apps/api/migrations';

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'coverage']);

function filesUnder(relativeDir: string, extension: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      if (SKIPPED_DIRS.has(entry)) {
        return [];
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return walk(full);
      }
      return entry.endsWith(extension) && !entry.endsWith('.d.ts') ? [relative(workspaceRoot, full)] : [];
    });
  return walk(join(workspaceRoot, relativeDir));
}

const isShipped = (file: string): boolean => !/\.spec\.ts$/.test(file) && !file.includes('/testing/');
const SOURCES = [...filesUnder('apps', '.ts'), ...filesUnder('libs', '.ts')].filter(isShipped);

interface References {
  /** A string or template literal names the table: SQL, never a comment. */
  readonly table: boolean;
  /** An identifier names the repository (an import, a `new`, a type). */
  readonly repo: boolean;
  /** A literal names `audit_events`. */
  readonly auditTable: boolean;
}

function referencesOf(file: string): References {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(workspaceRoot, file), 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  let table = false;
  let repo = false;
  let auditTable = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      table ||= node.text.includes(TABLE);
      auditTable ||= node.text.includes('audit_events');
    }
    if (ts.isIdentifier(node) && node.text === REPO_NAME) {
      repo = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { table, repo, auditTable };
}

describe('runner checks are advisory (#1059 S8)', () => {
  it('finds the repository and its callers, so the scan reads the sources it is meant to', () => {
    expect(SOURCES).toContain(REPO);
    expect(referencesOf(REPO).table).toBe(true);
    for (const caller of REPO_CALLERS) {
      expect(SOURCES).toContain(caller);
    }
  });

  it('keeps every SQL statement naming runner_checks in RunnerChecksRepo', () => {
    expect(SOURCES.filter((file) => referencesOf(file).table)).toEqual([REPO]);
  });

  it('is used only by the check routes, the claim’s delivery and the revoke batch', () => {
    const users = SOURCES.filter(
      (file) => file !== REPO && file !== `${DB_SRC}/index.ts` && referencesOf(file).repo,
    );
    expect(users.sort()).toEqual([...REPO_CALLERS].sort());
  });

  it.each(JOB_PATH)('%s never reads runner checks', (file) => {
    expect(SOURCES).toContain(file);
    expect(referencesOf(file)).toMatchObject({ table: false, repo: false });
  });

  it('writes its audit rows through auditedWrite only (the redactor runs on details)', () => {
    const repo = readFileSync(join(workspaceRoot, REPO), 'utf8');
    expect(referencesOf(REPO).auditTable).toBe(false);
    expect(repo).toMatch(/import \{ auditedWrite \} from '\.\.\/accounts\/audit\.repo'/);
  });

  it('names runner_checks in migration 0049 alone, its deletion triggers included', () => {
    const naming = filesUnder(MIGRATIONS, '.sql').filter((file) =>
      readFileSync(join(workspaceRoot, file), 'utf8').includes(TABLE),
    );
    expect(naming).toEqual([`${MIGRATIONS}/0049_runner_checks.sql`]);
  });
});
