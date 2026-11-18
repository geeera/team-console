/**
 * Where a `subscription` may run (ADR 0009 d.3, threat model C12 row 6): never on a hosted runner and never on a
 * GitHub Actions machine. These are SQL terms, so every write that could break the rule judges it inside its own
 * statement — the team-config save, a project's or an account's placement change — and a change that commits in
 * between cannot slip past a check read before the batch.
 */

/**
 * `EXISTS` a hosted, unrevoked runner of the project's account that the placement `policy` admits. `slug` and
 * `policy` are SQL expressions (a placeholder, a column, a subquery); `policy` NULL means `any`. Whether the runner
 * lists the project in `allowed_projects` is left out on purpose: that list changes without a placement write, so the
 * rule holds against any hosted runner the policy could ever pick.
 */
export function hostedRunnerAdmittedSql(slug: string, policy: string): string {
  return `EXISTS (
    SELECT 1 FROM runners h
    WHERE h.account_id = (SELECT account_id FROM projects WHERE slug = ${slug})
      AND h.hosted = 1 AND h.revoked_at IS NULL
      AND ${policyAdmitsRunnerSql(policy, 'h.id')})`;
}

/**
 * The runner row aliased `runner` serves the project `slug` (an SQL expression) under its scope (#775, migration
 * 0036): `selected` is the list in `allowed_projects`; `all` is every project of the account — with owner decision
 * D3 (2026-11-17): in an account with more than one owner, a runner that can serve a Claude subscription (its
 * `capabilities.accessSources` names `subscription`, or declares nothing) serves under `all` only the projects the
 * enrolling owner created; the other owners' projects need explicit selection. An API-key-only runner is one
 * person's bill, not one person's subscription doing another's work, so D3 leaves it alone.
 *
 * The project term only: **every** caller ANDs it with the account equality (`runner.account_id = jobs.account_id`
 * or `= p.account_id`), so a tampered list or a slug of another account never reaches past the account boundary
 * (threat model C9, R-SCOPE-3). `hostedRunnerAdmittedSql` stays blind to it on purpose (R-SCOPE-4).
 */
export function runnerServesSql(runner: string, slug: string): string {
  const subscriptionCapable = `(json_type(${runner}.capabilities, '$.accessSources') IS NULL
          OR EXISTS (SELECT 1 FROM json_each(${runner}.capabilities, '$.accessSources') WHERE value = 'subscription'))`;
  const oneOwner = `(SELECT COUNT(*) FROM account_members om WHERE om.account_id = ${runner}.account_id AND om.role = 'owner') <= 1`;
  const ownProject = `(${runner}.enrolled_by IS NOT NULL
          AND ${runner}.enrolled_by = (SELECT cp.created_by FROM projects cp WHERE cp.slug = ${slug}))`;
  return `(
      (${runner}.project_scope = 'all' AND (NOT ${subscriptionCapable} OR ${oneOwner} OR ${ownProject}))
      OR ${slug} IN (SELECT value FROM json_each(${runner}.allowed_projects))
    )`;
}

/**
 * `runnerServesSql` without D3: the scope alone covers `slug`. Only for telling the owner that D3 is what holds a
 * runner back (`other-owner-subscription`, #775); never a term of a claim or a write.
 */
export function runnerScopeCoversSql(runner: string, slug: string): string {
  return `(${runner}.project_scope = 'all' OR ${slug} IN (SELECT value FROM json_each(${runner}.allowed_projects)))`;
}

/**
 * The placement `policy` (an SQL expression; NULL means `any`) would pick the runner `runnerId` (an SQL expression)
 * for a job. Machine-agnostic: whether the runner is hosted or lists the project is the caller's to add.
 */
export function policyAdmitsRunnerSql(policy: string, runnerId: string): string {
  return `(
        ${policy} IS NULL
        OR json_extract(${policy}, '$.mode') = 'any'
        OR (json_extract(${policy}, '$.mode') = 'pinned' AND json_extract(${policy}, '$.runner') = ${runnerId})
        OR (json_extract(${policy}, '$.mode') = 'failover' AND (
              json_extract(${policy}, '$.preferred') = ${runnerId}
              OR ${runnerId} IN (SELECT value FROM json_each(${policy}, '$.fallback'))))
      )`;
}

/**
 * The claim's placement term (ADR 0008 decision 12), which `policyAdmitsRunnerSql` widens on purpose: `failover` takes
 * a fallback only while the preferred is revoked or silent past `offline_after_seconds` at `now`. The claim and the
 * jobs tile's `runnerAvailability` (#775) share it, so the tile never says `ready` for a runner the claim would skip.
 * Every argument is an SQL expression; `offlineDefault` stands for a policy without `offline_after_seconds`.
 */
export function claimPlacementAdmitsSql(policy: string, runnerId: string, now: string, offlineDefault: string): string {
  return `(
               ${policy} IS NULL
               OR json_extract(${policy}, '$.mode') = 'any'
               OR (json_extract(${policy}, '$.mode') = 'pinned' AND json_extract(${policy}, '$.runner') = ${runnerId})
               OR (json_extract(${policy}, '$.mode') = 'failover' AND (
                    json_extract(${policy}, '$.preferred') = ${runnerId}
                    OR (${runnerId} IN (SELECT value FROM json_each(${policy}, '$.fallback'))
                        AND NOT EXISTS (
                          SELECT 1 FROM runners pr
                          WHERE pr.id = json_extract(${policy}, '$.preferred') AND pr.revoked_at IS NULL
                            AND pr.last_seen_at IS NOT NULL
                            AND (julianday(${now}) - julianday(pr.last_seen_at)) * 86400.0
                                < COALESCE(json_extract(${policy}, '$.offline_after_seconds'), ${offlineDefault})))
               ))
             )`;
}

/**
 * The runner row aliased `runner` may take a job of the project aliased `project` by access source: C12 row 6 on the
 * server-set columns (a `subscription` never on a hosted or `actions-ephemeral` runner), then the runner's declared
 * `capabilities.accessSources`, which only ever narrows (SECURITY Q7). Shared by the claim and `runnerAvailability`.
 */
export function runnerFitsAccessSourceSql(runner: string, project: string): string {
  return `(${project}.access_source = 'api_key' OR (${runner}.hosted = 0 AND ${runner}.isolation <> 'actions-ephemeral'))
                 AND (json_type(${runner}.capabilities, '$.accessSources') IS NULL
                      OR ${project}.access_source IN (SELECT value FROM json_each(${runner}.capabilities, '$.accessSources')))`;
}

/**
 * A hosted runner `runnerId` about to be enrolled in `accountId` (both SQL expressions) would be admitted by the
 * effective placement of one of the account's `subscription` projects (#707): the enrolment write refuses then, as
 * the placement and team-config writes refuse the same state from their side.
 */
export function hostedEnrolmentRefusedSql(accountId: string, runnerId: string): string {
  return `EXISTS (
    SELECT 1 FROM projects sp
    WHERE sp.account_id = ${accountId} AND sp.access_source = 'subscription'
      AND ${policyAdmitsRunnerSql(effectivePolicySql('sp.slug'), runnerId)})`;
}

/** The project's effective placement: its own policy, else its account's default (ADR 0008 decision 12). */
export function effectivePolicySql(slug: string): string {
  return `(SELECT COALESCE(ep.runner_policy, ea.default_runner_policy)
    FROM projects ep JOIN accounts ea ON ea.id = ep.account_id WHERE ep.slug = ${slug})`;
}

/** The project runs its jobs on GitHub Actions machines (0031, #668): a `subscription` must never reach them. */
export function actionsDispatchSql(slug: string): string {
  return `EXISTS (SELECT 1 FROM projects dp WHERE dp.slug = ${slug} AND dp.dispatch = 'actions')`;
}

/**
 * The dispatch side of `subscriptionHostedSql` (#706): true when switching the project to `dispatch` would give a
 * `subscription` project an Actions path. `slug` and `dispatch` are SQL expressions.
 */
export function subscriptionActionsSql(slug: string, dispatch: string): string {
  return `(${dispatch} = 'actions' AND (SELECT sp.access_source FROM projects sp WHERE sp.slug = ${slug}) = 'subscription')`;
}

/**
 * True when a project with `source` would have a hosted or Actions path: `source` must then not be `subscription`.
 * The team-config save judges both halves. A placement write judges only the hosted half (it cannot change dispatch);
 * the dispatch switch (#670) needs the reverse: `actions` refused while the project's source is `subscription`.
 */
export function subscriptionHostedSql(slug: string, source: string, policy: string = effectivePolicySql(slug)): string {
  return `(${source} = 'subscription' AND (${hostedRunnerAdmittedSql(slug, policy)} OR ${actionsDispatchSql(slug)}))`;
}
