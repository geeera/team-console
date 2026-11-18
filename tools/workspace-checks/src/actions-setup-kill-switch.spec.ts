import { workspaceRoot } from '@nx/devkit';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEPLOY_ENVIRONMENTS, readWorkerConfig } from './support/wrangler-config';

/**
 * #759 PR 4, SEC 4 (ADR 0008 decision 7(a′), "The kill switch of the setup write"). The console's write to a customer
 * repository runs only while two things hold: the reviewed var `ALLOW_ACTIONS_SETUP_WRITE` of the api Worker is
 * exactly `true`, and no operator stop is in D1. The var is switched on by a reviewed change of `wrangler.jsonc` and
 * by nothing else, so nothing may override it at deploy time or shadow it with a secret; the stop is written by the
 * operator alone, so no Worker code may write its table.
 */

const SWITCH = 'ALLOW_ACTIONS_SETUP_WRITE';
const STOPS_TABLE = 'operator_stops';
const THIS_SPEC = 'tools/workspace-checks/src/actions-setup-kill-switch.spec.ts';
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.angular', '.nx', 'coverage', '.git']);

function filesUnder(relativeDir: string): string[] {
  const root = join(workspaceRoot, relativeDir);
  if (!existsSync(root)) {
    return [];
  }
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      if (SKIPPED_DIRS.has(entry)) {
        return [];
      }
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [relative(workspaceRoot, full)];
    });
  return walk(root);
}

const read = (file: string): string => readFileSync(join(workspaceRoot, file), 'utf8');

/** Everything that deploys, configures or scripts a Worker: workflows, owner tooling, project targets, runbooks. */
const DEPLOY_SURFACE = [
  ...filesUnder('.github'),
  ...filesUnder('tools').filter((file) => file !== THIS_SPEC && !file.endsWith('worker-config.spec.ts')),
  ...filesUnder('apps').filter((file) => /(?:^|\/)(?:project\.json|package\.json|.*\.sh|.*\.ya?ml)$/.test(file)),
  ...filesUnder('docs/runbooks'),
  'package.json',
];

describe('ALLOW_ACTIONS_SETUP_WRITE is set by the reviewed wrangler.jsonc alone (#759 SEC 4)', () => {
  it('reads the deploy surface it is meant to', () => {
    expect(DEPLOY_SURFACE).toContain('.github/workflows/deploy.yml');
    expect(DEPLOY_SURFACE).toContain('apps/api/project.json');
    expect(DEPLOY_SURFACE).toContain('tools/owner-setup/create-apps.sh');
    expect(read('.github/workflows/deploy.yml')).toMatch(/--var [A-Z_]+:\$\{\{ vars\./);
  });

  it('is never passed as --var: a deploy cannot override the committed value', () => {
    const overriding = DEPLOY_SURFACE.filter((file) => new RegExp(`--var[\\s=]+["']?${SWITCH}\\b`).test(read(file)));
    expect(overriding).toEqual([]);
  });

  it('is never a secret: no `secret put` or `secret bulk` names it, and no workflow reads it from secrets or vars', () => {
    const asSecret = DEPLOY_SURFACE.filter((file) =>
      new RegExp(`secret\\s+(?:put|bulk)[^\\n]*${SWITCH}|(?:secrets|vars)\\.${SWITCH}\\b`).test(read(file)),
    );
    expect(asSecret).toEqual([]);
    // No workflow or owner script names it at all: it has no value outside wrangler.jsonc.
    const named = [...filesUnder('.github'), ...filesUnder('tools/owner-setup')].filter((file) => read(file).includes(SWITCH));
    expect(named).toEqual([]);
  });

  it('is a wrangler var of the api Worker in the environment manifest, generated, with no other location', () => {
    const manifest = read('.product-team/environment-manifest.yml');
    const start = manifest.indexOf(`- name: ${SWITCH}\n`);
    expect(start).toBeGreaterThan(-1);
    const next = manifest.indexOf('\n  - name: ', start + 1);
    const entry = manifest.slice(start, next === -1 ? undefined : next);
    expect(entry).toContain('kind: variable');
    expect(entry).toContain('origin: generated');
    expect(entry).toContain('locations: [{ place: wrangler-var, app: api }]');
    expect(entry).not.toMatch(/kind: secret|wrangler-secret|github-secret|github-variable/);
  });

  it.each(DEPLOY_ENVIRONMENTS)('is the literal true or false in apps/api/wrangler.jsonc for %s, and absent on hooks', (env) => {
    expect(['true', 'false']).toContain(readWorkerConfig('api', env).vars[SWITCH]);
    expect(readWorkerConfig('hooks', env).vars).not.toHaveProperty(SWITCH);
  });

  it('is read by one function of the api Worker, and only its exact `true` switches the path on', () => {
    const sources = [...filesUnder('apps'), ...filesUnder('libs')].filter(
      (file) => file.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(file) && !file.includes('/testing/'),
    );
    const readers = sources.filter((file) => new RegExp(`\\.${SWITCH}\\b|\\[['"]${SWITCH}['"]\\]`).test(read(file)));
    expect(readers).toEqual(['apps/api/src/github.ts']);
    expect(read('apps/api/src/github.ts')).toContain(`env.${SWITCH} === 'true' ? 'enabled' : 'disabled'`);
  });
});

describe('the operator’s stop is written by the operator alone (#759 SEC 4)', () => {
  const sources = [...filesUnder('apps'), ...filesUnder('libs')].filter(
    (file) => file.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(file) && !file.includes('/testing/'),
  );

  it('names the table in one repository of @worker/db, which only selects from it', () => {
    const mentions = sources.filter((file) => read(file).includes(STOPS_TABLE));
    expect(mentions).toEqual(['libs/worker/db/src/lib/operator-stops.repo.ts']);
    const statements = read(mentions[0] ?? '').match(/`[^`]*operator_stops[^`]*`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^`SELECT\b/);
      expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i);
    }
  });

  it('is asked on every request of the write route, by the one module that mints the write token', () => {
    const callers = sources.filter((file) => read(file).includes('OperatorStopsRepo(')).sort();
    expect(callers).toEqual(['apps/api/src/actions/workflow-pr.ts']);
    const flow = read('apps/api/src/actions/workflow-pr.ts');
    // The stop is judged before the mint, in the function that mints.
    expect(flow.indexOf('await isSetupWriteAllowed(env)')).toBeGreaterThan(-1);
    expect(flow.indexOf('await isSetupWriteAllowed(env)')).toBeLessThan(flow.indexOf(".mintScoped('workflow-pr'"));
  });

  it('is documented as an incident step that needs no deploy', () => {
    const runbook = read('docs/runbooks/deploy-and-rollback.md');
    expect(runbook).toContain(`INSERT INTO ${STOPS_TABLE} (name, stopped_at, reason)`);
    expect(runbook).toContain("'actions-setup-write'");
    expect(runbook).toContain(`DELETE FROM ${STOPS_TABLE}`);
    expect(read('docs/decisions/0008-multi-tenant-console.md')).toContain(STOPS_TABLE);
  });
});
