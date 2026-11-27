import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #809, the claim-agreement matrix: the jobs tile's `RunnersRepo.availabilityOf` (#775) says `ready` only when the
 * claim (`JobsRepo.claim`) would take the job, so every runner term of the claim, with its team-pause and `needs_local`
 * terms (#810), must appear in it too. Each term the
 * claim interpolates or reads off its runner row is listed here, either as mirrored (with the form availability must
 * use) or as left to the claim on purpose (transient: it makes a job wait, not fail to start). A new claim term fails
 * this check until it is mirrored or listed with its reason. What the terms answer is
 * `libs/worker/db/src/lib/team-config/access-source.spec.ts`.
 */

const read = (path: string): string => readFileSync(join(workspaceRoot, path), 'utf8');

const JOBS = 'libs/worker/db/src/lib/jobs/jobs.repo.ts';
const RUNNERS = 'libs/worker/db/src/lib/runners/runners.repo.ts';
const POLL_ROUTE = 'apps/api/src/routes/runner-jobs.ts';

function between(source: string, start: string, end: string, file: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) {
    throw new Error(
      `${file}: cannot find \`${start}\` … \`${end}\`; update this check with the method's new shape`,
    );
  }
  return source.slice(from, to);
}

const claim = between(read(JOBS), 'async claim(request: ClaimRequest)', 'async concurrencyStopsOf(', JOBS);
const availability = between(read(RUNNERS), 'async availabilityOf(', 'async unavailableReasonOf(', RUNNERS);

interface MirroredTerm {
  readonly name: string;
  /** The term as the claim writes it: pins the row of the matrix to the claim, so it cannot go stale. */
  readonly inClaim: RegExp;
  /** The same term as `availabilityOf` must write it (its runner is `r`, its project `p`, `now` is `?2`). */
  readonly inAvailability: RegExp;
}

const POLICY_EXPRESSION = 'COALESCE(p.runner_policy, a.default_runner_policy)';

const MIRRORED: readonly MirroredTerm[] = [
  {
    name: 'runnerServesSql (scope, D3)',
    inClaim: /\$\{runnerServesSql\('r', 'j\.project_slug'\)\}/u,
    inAvailability: /\$\{runnerServesSql\('r', 'p\.slug'\)\}/u,
  },
  {
    name: 'runnerFitsAccessSourceSql (C12 row 6, declared sources)',
    inClaim: /\$\{runnerFitsAccessSourceSql\('me', 'p'\)\}/u,
    inAvailability: /\$\{runnerFitsAccessSourceSql\('r', 'p'\)\}/u,
  },
  {
    name: 'claimPlacementAdmitsSql (placement, failover silence)',
    inClaim: /\$\{claimPlacementAdmitsSql\(POLICY, '\?1', '\?2', '\?7'\)\}/u,
    inAvailability:
      /\$\{claimPlacementAdmitsSql\('COALESCE\(p\.runner_policy, a\.default_runner_policy\)', 'r\.id', '\?2', '\?4'\)\}/u,
  },
  {
    name: 'the placement offline default',
    inClaim: /RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS/u,
    inAvailability: /RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS/u,
  },
  {
    name: 'the account equality',
    inClaim: /r\.account_id = \?5/u,
    inAvailability: /r\.account_id = p\.account_id/u,
  },
  {
    name: 'the runner is not revoked',
    inClaim: /r\.revoked_at IS NULL/u,
    inAvailability: /r\.revoked_at IS NULL/u,
  },
  {
    name: 'the runner pause (the tile reports it as `paused`)',
    inClaim: /me\.paused_until/u,
    inAvailability: /r\.paused_until/u,
  },
  {
    name: 'the account is not suspended, the project not archived',
    inClaim: /a\.suspended_at IS NULL AND p\.archived_at IS NULL/u,
    inAvailability: /a\.suspended_at IS NULL AND p\.archived_at IS NULL/u,
  },
  {
    name: "the team's pause (#810; the tile reports it as `team-paused`)",
    inClaim: /LEFT JOIN team_state t ON t\.project_slug = j\.project_slug[\s\S]*AND t\.paused_at IS NULL/u,
    inAvailability:
      /\(t\.paused_at IS NULL\) AS team_running[\s\S]*LEFT JOIN team_state t ON t\.project_slug = p\.slug[\s\S]*row\.team_running !== 1/u,
  },
  {
    // ?6 is `request.local`: the claiming runner's stored `capabilities.local` (pinned by its own case below).
    name: 'needs_local only for a local runner (#810)',
    inClaim: /\(j\.needs_local = 0 OR \?6 = 1\)/u,
    inAvailability: /\(\?5 = 0 OR json_extract\(r\.capabilities, '\$\.local'\) = 1\)/u,
  },
];

/** Interpolations of the claim that `availabilityOf` leaves out on purpose, and why. */
const CLAIM_ONLY_INTERPOLATIONS: Readonly<Record<string, string>> = {
  ROLE_ADMITTED_SQL: "transient: the role's switch and max_parallel make a job wait",
  budgetAdmittedSql: 'transient: the budget stop has its own "Needs you" reason',
  entitledConcurrencyAdmittedSql: "transient: the account's concurrency makes a job wait",
  COLUMNS: 'not a term: the RETURNING list',
};

/** Columns of the claim's runner rows (`r`, `me`) by the mirrored term that judges them, or why none needs to. */
const RUNNER_COLUMNS: Readonly<Record<string, string>> = {
  id: 'the claiming runner itself (?1)',
  account_id: 'the account equality',
  revoked_at: 'the runner is not revoked',
  paused_until: 'the runner pause',
  capabilities:
    "transient: the runner's free slots (maxConcurrency); accessSources is runnerFitsAccessSourceSql",
};

/**
 * Columns of the claim's candidate job (`j`) and team row (`t`) by the term that judges them (#810). Availability is
 * asked for the job a Run now creates: queued, `pull` unless the project dispatches to Actions, of the project's
 * account, and `needs_local` as its caller says (Run now: never).
 */
const JOB_AND_TEAM_COLUMNS: Readonly<Record<string, string>> = {
  'j.id': 'the candidate job itself',
  'j.state': 'a queued job, which a Run now creates',
  'j.dispatch': "the project's dispatch: an Actions project is ready without a runner",
  'j.account_id': 'the account equality (the job takes its project’s account)',
  'j.project_slug': 'the project availability is asked for',
  'j.needs_local': 'needs_local only for a local runner',
  'j.priority': 'not a term: the order among queued jobs',
  'j.created_at': 'not a term: the order among queued jobs',
  't.project_slug': "the team's pause (the join)",
  't.paused_at': "the team's pause",
};

const MIRRORED_INTERPOLATIONS = new Set([
  'runnerServesSql',
  'runnerFitsAccessSourceSql',
  'claimPlacementAdmitsSql',
]);

describe('the claim and availabilityOf agree on every runner term', () => {
  it('each mirrored term is still the one the claim writes', () => {
    const stale = MIRRORED.filter((term) => !term.inClaim.test(claim)).map((term) => term.name);
    expect(stale, `${JOBS}: the claim no longer writes these matrix rows; update the matrix`).toEqual([]);
  });

  it('availabilityOf carries every mirrored claim term', () => {
    const missing = MIRRORED.filter((term) => !term.inAvailability.test(availability)).map(
      (term) => term.name,
    );
    expect(
      missing,
      `${RUNNERS}: availabilityOf lacks claim term(s) [${missing.join('; ')}], so the tile could say ready for a runner the claim skips`,
    ).toEqual([]);
  });

  it("the claim's `local` is the runner's stored `capabilities.local`, which availabilityOf reads", () => {
    expect(claim).toMatch(/request\.local \? 1 : 0,/u);
    expect(read(POLL_ROUTE)).toMatch(/local: runner\.capabilities\.local,/u);
  });

  it("the claim's placement policy is the expression availabilityOf uses", () => {
    expect(read(JOBS)).toContain(`const POLICY = \`${POLICY_EXPRESSION}\`;`);
  });

  it('every interpolation of the claim is mirrored or listed as claim-only', () => {
    const names = [...claim.matchAll(/\$\{(\w+)/gu)].map((match) => match[1] ?? '');
    expect(names.length).toBeGreaterThanOrEqual(6);
    const unclassified = names.filter(
      (name) => !MIRRORED_INTERPOLATIONS.has(name) && !(name in CLAIM_ONLY_INTERPOLATIONS),
    );
    expect(
      unclassified,
      `${JOBS}: new claim term(s); mirror them in availabilityOf (${RUNNERS}) and this matrix, or list them as claim-only`,
    ).toEqual([]);
  });

  it('every column the claim reads off its runner rows is classified', () => {
    const columns = new Set([...claim.matchAll(/\b(?:r|me)\.(\w+)/gu)].map((match) => match[1] ?? ''));
    const unclassified = [...columns].filter((column) => !(column in RUNNER_COLUMNS));
    expect(
      unclassified,
      `${JOBS}: the claim judges runner column(s) this matrix does not know; mirror the term in availabilityOf (${RUNNERS})`,
    ).toEqual([]);
  });

  it('every column the claim reads off its candidate job and team row is classified', () => {
    const columns = new Set([...claim.matchAll(/\b(?:j|t)\.\w+/gu)].map((match) => match[0]));
    expect(columns).toContain('j.needs_local');
    expect(columns).toContain('t.paused_at');
    const unclassified = [...columns].filter((column) => !(column in JOB_AND_TEAM_COLUMNS));
    expect(
      unclassified,
      `${JOBS}: the claim judges job or team column(s) this matrix does not know; mirror the term in availabilityOf (${RUNNERS})`,
    ).toEqual([]);
  });
});
