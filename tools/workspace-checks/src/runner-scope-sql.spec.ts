import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #775, threat model R-SCOPE-3 at the source: the runner's project term lives in `runnerServesSql` alone, and every
 * SQL that serves a job to a runner keeps the account equality beside it. The behaviour half (what the term answers
 * against D1, the hosted invariant) is `libs/worker/db/src/lib/team-config/access-source.spec.ts`.
 */

const read = (path: string): string => readFileSync(join(workspaceRoot, path), 'utf8');

const SOURCES = [
  'libs/worker/db/src/lib/jobs/jobs.repo.ts',
  'libs/worker/db/src/lib/runners/runners.repo.ts',
  'libs/worker/db/src/lib/team-config/access-source.ts',
  'libs/worker/db/src/lib/team-config/claim-admission.ts',
  'libs/worker/db/src/lib/accounts/accounts.repo.ts',
  'libs/worker/db/src/lib/team-config/team-config.repo.ts',
];

describe('runnerServesSql is the one project term of a runner', () => {
  it('no source reads json_each(<runner>.allowed_projects) as a serving term outside it', () => {
    for (const file of SOURCES) {
      const terms = read(file).match(/IN \(SELECT value FROM json_each\((\w+|\$\{runner\})\.allowed_projects\)\)/gu) ?? [];
      // `access-source.ts` holds the one in `runnerServesSql`; `setScope` compares the row's own column
      // (`runners.allowed_projects`) to decide whether anything changed, not whether a job is served.
      const outside = terms.filter((term) => !term.includes('${runner}') && !term.includes('runners.allowed_projects'));
      expect(outside, `${file}: ${outside.join(' | ')}`).toEqual([]);
    }
  });

  it('every caller keeps the account equality beside the term', () => {
    const jobs = read('libs/worker/db/src/lib/jobs/jobs.repo.ts');
    // The claim: the runner row by id, inside the claiming account, then the scope term.
    expect(jobs).toMatch(/r\.id = \?1 AND r\.account_id = \?5 AND r\.revoked_at IS NULL AND \$\{runnerServesSql\('r', 'j\.project_slug'\)\}/u);
    // The still-allows term every heartbeat, events, finish and tracker write re-judges inside its batch.
    expect(jobs).toMatch(/r\.account_id = jobs\.account_id AND r\.revoked_at IS NULL\s+AND \$\{runnerServesSql\('r', 'jobs\.project_slug'\)\}/u);
    // The read path of the owner's list and `/runner/self`: the project joined on the runner's account.
    const runners = read('libs/worker/db/src/lib/runners/runners.repo.ts');
    expect(runners).toMatch(/JOIN projects p ON p\.account_id = r\.account_id[\s\S]*\$\{runnerServesSql\('r', 'p\.slug'\)\}/u);
    // Each use of the term in these files names a runner alias that the same statement binds to an account.
    const uses = [...jobs.matchAll(/runnerServesSql\('(\w+)'/gu), ...runners.matchAll(/runnerServesSql\('(\w+)'/gu)];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    expect(uses.every((use) => use[1] === 'r')).toBe(true);
  });

  it('hostedRunnerAdmittedSql stays blind to the scope and the list (C12 row 6)', () => {
    const source = read('libs/worker/db/src/lib/team-config/access-source.ts').replace(/\/\*\*[\s\S]*?\*\//gu, '');
    const hosted = source.slice(source.indexOf('export function hostedRunnerAdmittedSql'), source.indexOf('export function runnerServesSql'));
    expect(hosted).toContain('h.hosted = 1');
    expect(hosted).not.toContain('project_scope');
    expect(hosted).not.toContain('allowed_projects');
  });
});
