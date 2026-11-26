import {
  TEAM_CONFIG_BOUNDS,
  TEAM_CONFIG_PRESET_ROLES,
  TEAM_CONFIG_PRESETS,
  TEAM_ROLES,
  entitlementsOf,
} from '@shared/contracts';

/**
 * The claim's role admission (ADR 0009 d.6, d.7; threat model C12 row 5, T6): a WHERE term on the candidate `j`
 * (with `tc`, the project's `team_configs` row, LEFT JOINed). A role the document switched off is never claimed, and
 * a role holding its `max_parallel` live jobs on the project waits; a member the document leaves out comes from its
 * preset, bound as `presets`, and a role no preset knows from the bound's top, `top` (the placeholders of
 * `roleAdmissionParams`). Roles are matched by `json_each` key, never spliced into a JSON path, so no stored role
 * name can break the statement. The pull claim and the OIDC exchange (#706) both hold it inside their own write.
 */
export function roleAdmittedSql(presets: string, top: string, options: RoleAdmissionOptions = {}): string {
  // A dispatched Actions job no run has exchanged yet holds its slot too (#716, #722): its run is on the way, so a
  // second dispatch would start a run the exchange then refuses. The exchange itself leaves them out, `j` among them.
  const dispatched =
    options.countDispatched === true
      ? ` OR (live.state = 'queued' AND live.dispatch = 'actions' AND live.dispatched_at IS NOT NULL
             AND live.runner_id IS NULL AND live.id <> j.id)`
      : '';
  return `COALESCE(
    (SELECT json_extract(r.value, '$.enabled') FROM json_each(tc.config, '$.roles') r WHERE r.key = j.role), 1) = 1
  AND (SELECT COUNT(*) FROM jobs live
       WHERE live.project_slug = j.project_slug AND live.role = j.role
         AND (live.state IN ('claimed', 'running')${dispatched}))
    < COALESCE(
        (SELECT json_extract(r.value, '$.max_parallel') FROM json_each(tc.config, '$.roles') r WHERE r.key = j.role),
        (SELECT r.value FROM json_each(${presets}) pr, json_each(pr.value) r
         WHERE pr.key = COALESCE(json_extract(tc.config, '$.preset'), 'recommended') AND r.key = j.role),
        ${top})`;
}

export interface RoleAdmissionOptions {
  /** Count the role's dispatched, not yet exchanged Actions jobs as live (the pull claim and the dispatch). */
  readonly countDispatched?: boolean;
}

/** The pull claim's term, its two values bound as `?8` and `?9`. */
export const ROLE_ADMITTED_SQL = roleAdmittedSql('?8', '?9', { countDispatched: true });

/**
 * The budget stop's term on the candidate `j` (#684, ADR 0009 d.6, threat model C12 row 5), with `tc` LEFT JOINed as
 * for `roleAdmittedSql`: a project whose spend in the UTC month of `now` (an ISO instant ending in `Z`) reached its
 * `budget.monthly_usd` is not admitted, unless the owner waived the budget for that month ("Resume this month"). Judged
 * here, not only at `finish`, so a budget lowered below the month's spend stops the very next claim. No budget (a
 * `null` or no document) compares as NULL and admits.
 */
export function budgetAdmittedSql(now: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM project_spend ps
    WHERE ps.project_slug = j.project_slug AND ps.month = substr(${now}, 1, 7) AND ps.waived_at IS NULL
      AND ps.spent_usd >= json_extract(tc.config, '$.budget.monthly_usd'))`;
}

/**
 * The account's entitled concurrency (#746, ADR 0008 decision 6): `entitlementsOf(account).maxConcurrency`, with the
 * row's raw `plan` and `entitlements` it was computed from, so a write can require the row to read the same when it
 * commits (`entitledConcurrencyAdmittedSql`).
 */
export interface EntitledConcurrency {
  readonly limit: number;
  readonly plan: string;
  readonly entitlements: string;
}

/** `entitlementsOf` on a raw `accounts` row; an override that does not parse yields the free tier, as the guard does. */
export function entitledConcurrencyOf(row: {
  readonly plan: string;
  readonly entitlements: string;
}): EntitledConcurrency {
  let override: unknown = null;
  try {
    override = JSON.parse(row.entitlements) as unknown;
  } catch (error: unknown) {
    // 0018 CHECKs the column as a JSON object, so this is a broken row: `null` fails `isEntitlementsOverride` closed.
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return {
    limit: entitlementsOf({ plan: row.plan, entitlements: override }).maxConcurrency,
    plan: row.plan,
    entitlements: row.entitlements,
  };
}

/**
 * The account-wide in-flight count of the candidate `j` is below `limit` (an SQL expression), #746: every claimed or
 * running job of `j`'s account, plus its dispatched Actions jobs no run has exchanged yet (their runs are on the way,
 * as `roleAdmittedSql` counts them), `j` itself left out. Judged inside the write that hands `j` out (the pull claim,
 * the dispatch's compare-and-set, the OIDC exchange), so two of them racing for the account's last slot never both
 * pass: D1 runs one statement at a time.
 */
export function accountInFlightBelowSql(limit: string): string {
  return `(SELECT COUNT(*) FROM jobs inflight
      WHERE inflight.account_id = j.account_id AND inflight.state IN ('queued', 'claimed', 'running')
        AND (inflight.state <> 'queued'
             OR (inflight.dispatch = 'actions' AND inflight.dispatched_at IS NOT NULL AND inflight.runner_id IS NULL
                 AND inflight.id <> j.id))) < ${limit}`;
}

/**
 * `accountInFlightBelowSql` against an `EntitledConcurrency` bound as `limit`, `plan` and `entitlements` (with `a`,
 * `j`'s account, joined): the account row must still read as it did when the limit was computed, so an operator change
 * that commits between that read and this write takes nothing rather than the old limit.
 */
export function entitledConcurrencyAdmittedSql(limit: string, plan: string, entitlements: string): string {
  return `a.plan = ${plan} AND a.entitlements = ${entitlements} AND ${accountInFlightBelowSql(limit)}`;
}

/** The values of `entitledConcurrencyAdmittedSql`'s three placeholders, in order. */
export function entitledConcurrencyParams(entitled: EntitledConcurrency): readonly [number, string, string] {
  return [entitled.limit, entitled.plan, entitled.entitlements];
}

/** `{ preset: { role: max_parallel } }` from the shared presets: the data the claim falls back to. */
const PRESET_MAX_PARALLEL = JSON.stringify(
  Object.fromEntries(
    TEAM_CONFIG_PRESETS.map((preset) => [
      preset,
      Object.fromEntries(
        TEAM_ROLES.map((role) => [role, TEAM_CONFIG_PRESET_ROLES[preset][role].max_parallel]),
      ),
    ]),
  ),
);

/** The values of `presets` and `top` in `roleAdmittedSql` (`?8` and `?9` in `ROLE_ADMITTED_SQL`). */
export function roleAdmissionParams(): readonly [string, number] {
  return [PRESET_MAX_PARALLEL, TEAM_CONFIG_BOUNDS.maxParallel.max];
}
