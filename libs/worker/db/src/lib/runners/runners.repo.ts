import {
  RUNNER_ONLINE_WINDOW_SECONDS,
  RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS,
  isAccessSource,
  isRunnerCheckKind,
  type AccessSource,
  type Ed25519PublicJwk,
  type RunnerAvailability,
  type RunnerCapabilitiesDto,
  type RunnerCheckKind,
  type RunnerUnavailableReason,
  type RunnerHostDto,
  type RunnerIsolation,
  type RunnerPauseReason,
  type RunnerProjectScope,
  type RunnerProjectScopeDto,
  type RunnerSuspectReason,
} from '@shared/contracts';
import { auditEventStatement, auditedWrite, type NewAuditEvent } from '../accounts/audit.repo';
import { isConstraintError } from '../tracker/constraint-error';
import {
  claimPlacementAdmitsSql,
  hostedEnrolmentRefusedSql,
  runnerAccountHasOneOwnerSql,
  runnerFitsAccessSourceSql,
  runnerScopeCoversSql,
  runnerServesSql,
  runnerTakesSubscriptionSql,
} from '../team-config/access-source';

/**
 * Runners and their enrolment codes (#467, ADR 0008 row 2-A, migration 0021). Every write names the account it acts
 * in, so a runner of account A is never read, revoked or re-scoped through account B's routes; the audit row of a
 * change travels in the change's own batch.
 */

/** What `setScope` did (#795). */
export type ScopeWrite = 'changed' | 'unchanged' | 'enroller-only';

/**
 * The writer `by` (an SQL expression: their audit actor) counts as the enroller of the row aliased `runner` (#795): it
 * names them, or it is from before `enrolled_by` (NULL, migration 0036) and the account has one owner, its writer.
 */
function writerIsEnrollerSql(runner: string, by: string): string {
  return `((${runner}.enrolled_by IS NOT NULL AND ${runner}.enrolled_by = ${by})
    OR (${runner}.enrolled_by IS NULL AND ${runnerAccountHasOneOwnerSql(runner)}))`;
}

/**
 * The scope write bound as `setScope` binds it (?3 the new list, ?4 the new scope, ?5 the writer's audit actor) may
 * go ahead on the stored row aliased `runner` (#795): the runner cannot serve a subscription, or the writer counts as
 * its enroller, or the write adds nothing it does not serve now — a `selected` list of projects it serves already or
 * holds already (an entry D3 holds back stays held back, #824), or `all` on a runner that is `all` already. A row
 * from before `enrolled_by` is nobody's to add to once the account has a second owner, until it is enrolled again.
 */
function scopeWriteAllowedSql(runner: string): string {
  return `(
    NOT ${runnerTakesSubscriptionSql(runner)}
    OR ${writerIsEnrollerSql(runner, '?5')}
    OR (?4 = 'selected' AND NOT EXISTS (
      SELECT 1 FROM json_each(?3) added
      WHERE NOT ${runnerServesSql(runner, 'added.value')}
        AND added.value NOT IN (SELECT value FROM json_each(${runner}.allowed_projects))))
    OR (?4 = 'all' AND ${runner}.project_scope = 'all')
  )`;
}

/**
 * The `non_enroller_projects` a `setScope` write stores (#824, migration 0046), bound as `setScope` binds it: of the
 * new list, the entries a non-enroller added before and keeps, and, when the writer does not count as the enroller,
 * the entries this write adds. Every SET term reads the row as it was, so "adds" means "not in the stored list".
 */
function nonEnrollerProjectsAfterWriteSql(runner: string): string {
  return `(SELECT json_group_array(n.value) FROM json_each(?3) n
    WHERE n.value IN (SELECT value FROM json_each(${runner}.non_enroller_projects))
      OR (NOT ${writerIsEnrollerSql(runner, '?5')}
          AND n.value NOT IN (SELECT value FROM json_each(${runner}.allowed_projects))))`;
}

/** What `claimEnroller` did (#827); everything but `claimed` wrote and audited nothing. */
export type EnrollerClaim = 'claimed' | 'already-set' | 'not-sole-owner' | 'revoked' | 'fixed' | 'not-found';

/**
 * The claimer is the account's sole owner (#827, owner decision (a)), judged on the row aliased `runner` with the
 * claimer's user id bound as `userId`: at most one owner row (D3's own one-owner term), and none of another user. NULL
 * is the local bypass alone, which owns the account by its door, so only the count applies to it; the Access owner
 * before the link is refused by the route (#837), since a door owner beside one owner row would pass the count.
 */
function claimerIsSoleOwnerSql(runner: string, userId: string): string {
  return `(${runnerAccountHasOneOwnerSql(runner)}
    AND (${userId} IS NULL OR NOT EXISTS (
      SELECT 1 FROM account_members so WHERE so.account_id = ${runner}.account_id AND so.role = 'owner' AND so.user_id <> ${userId}
    )))`;
}

/** A runner whose enroller can be claimed (#827): no enroller recorded, self-hosted, unrevoked. */
function enrollerOpenSql(runner: string): string {
  return `(${runner}.enrolled_by IS NULL AND ${runner}.hosted = 0 AND ${runner}.isolation <> 'actions-ephemeral'
    AND ${runner}.revoked_at IS NULL)`;
}

export interface RunnerRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly hosted: boolean;
  readonly isolation: RunnerIsolation;
  /** #775: `all` serves every active project of the account (D3 applied); `selected` the list below. */
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
  /**
   * The audit actor who created the enrolment code (D3); `null` before 0036 and on OIDC identities. Kept once written
   * (0036 trigger), with one exception (#838, migration 0042): `access-owner`, the Access owner before the GitHub link,
   * becomes the linked user's id when the link is written — by a trigger on `users.access_subject`, never by this repo.
   */
  readonly enrolledBy: string | null;
  readonly version: string;
  readonly pinnedVersion: string | null;
  readonly enrolledAt: string;
  readonly lastSeenAt: string | null;
  readonly lastSeenCountry: string | null;
  readonly lastSeenIpHash: string | null;
  readonly seenCountries: readonly string[];
  readonly suspectAt: string | null;
  readonly suspectReason: RunnerSuspectReason | null;
  readonly revokedAt: string | null;
  /** The pause the runner posted (#571), as stored: the reader judges `until` against its own `now`. */
  readonly pause: { readonly reason: RunnerPauseReason; readonly until: string } | null;
}

export interface EnrolmentRecord {
  readonly codeHash: string;
  readonly accountId: string;
  readonly name: string;
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedByRunnerId: string | null;
  readonly usedAt: string | null;
}

export interface NewEnrolment {
  readonly codeHash: string;
  readonly accountId: string;
  readonly name: string;
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
  readonly createdBy: string;
  readonly at: string;
  readonly expiresAt: string;
}

export interface NewRunner {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly isolation: RunnerIsolation;
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
  /** The code's creator (D3). */
  readonly enrolledBy: string | null;
  readonly version: string;
  readonly at: string;
}

/** A project a runner serves now, as `servedProjectsOf` lists it: the scope's effective answer, D3 applied. */
export interface ServedProjectRecord {
  readonly runnerId: string;
  readonly slug: string;
  readonly accessSource: AccessSource;
}

/** `enrolHosted`: `access-source-hosted` when a `subscription` project's placement would admit the runner (#707). */
export type HostedEnrolOutcome = 'ok' | 'code-used' | 'access-source-hosted';

/** What a runner's call tells about its source, for presence and the detection rows of threat model C4. */
export interface RunnerSighting {
  readonly at: string;
  readonly country: string | null;
  readonly ipHash: string | null;
}

export interface SightingOutcome {
  /** A fresh alert this sighting raised (`null` when none, or when the runner is already marked suspect). */
  readonly alert: RunnerSuspectReason | null;
  readonly previousCountry: string | null;
}

interface RunnerRow {
  id: string;
  account_id: string;
  name: string;
  public_key_jwk: string;
  host: string;
  capabilities: string;
  hosted: number;
  isolation: RunnerIsolation;
  project_scope: RunnerProjectScope;
  allowed_projects: string;
  enrolled_by: string | null;
  version: string;
  pinned_version: string | null;
  enrolled_at: string;
  last_seen_at: string | null;
  last_seen_country: string | null;
  last_seen_ip_hash: string | null;
  seen_countries: string;
  suspect_at: string | null;
  suspect_reason: RunnerSuspectReason | null;
  revoked_at: string | null;
  paused_until: string | null;
  pause_reason: RunnerPauseReason | null;
}

interface EnrolmentRow {
  code_hash: string;
  account_id: string;
  name: string;
  project_scope: RunnerProjectScope;
  allowed_projects: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_by_runner_id: string | null;
  used_at: string | null;
}

const RUNNER_COLUMNS = `id, account_id, name, public_key_jwk, host, capabilities, hosted, isolation, project_scope,
  allowed_projects, enrolled_by, version, pinned_version, enrolled_at, last_seen_at, last_seen_country, last_seen_ip_hash,
  seen_countries, suspect_at, suspect_reason, revoked_at, paused_until, pause_reason`;
const ENROLMENT_COLUMNS = `code_hash, account_id, name, project_scope, allowed_projects, created_by, created_at, expires_at,
  used_by_runner_id, used_at`;
/** What the server gives a hosted or `actions-ephemeral` identity: never a subscription (C12 row 6). */
export const SERVER_SET_ACCESS_SOURCES: readonly AccessSource[] = ['api_key'];

/** Two source addresses inside this window on one runner id are two pollers (the lease length of ADR 0006). */
export const TWO_POLLERS_WINDOW_MS = 5 * 60 * 1000;

function stringList(json: string): readonly string[] {
  // The columns are CHECKed as JSON arrays; a member that is not a string is a broken row, dropped rather than served.
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function toRecord(row: RunnerRow): RunnerRecord {
  const host = JSON.parse(row.host) as Partial<RunnerHostDto>;
  const capabilities = JSON.parse(row.capabilities) as Partial<RunnerCapabilitiesDto>;
  const declared = capabilities.accessSources;
  const checks = capabilities.checks;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    publicKeyJwk: JSON.parse(row.public_key_jwk) as Ed25519PublicJwk,
    host: { os: host.os ?? '', arch: host.arch ?? '', hostname: host.hostname ?? '' },
    capabilities: {
      local: capabilities.local === true,
      maxConcurrency: capabilities.maxConcurrency ?? 1,
      // A stored declaration that is not a list of sources is a broken row: read as no declaration, never served.
      ...(Array.isArray(declared) && declared.every(isAccessSource) ? { accessSources: declared } : {}),
      // #1059: the same for the check kinds; a broken declaration reads as none, so enqueue answers `runner-outdated`.
      ...(Array.isArray(checks) && checks.every(isRunnerCheckKind) ? { checks } : {}),
    },
    hosted: row.hosted === 1,
    isolation: row.isolation,
    projectScope: row.project_scope,
    allowedProjects: stringList(row.allowed_projects),
    enrolledBy: row.enrolled_by,
    version: row.version,
    pinnedVersion: row.pinned_version,
    enrolledAt: row.enrolled_at,
    lastSeenAt: row.last_seen_at,
    lastSeenCountry: row.last_seen_country,
    lastSeenIpHash: row.last_seen_ip_hash,
    seenCountries: stringList(row.seen_countries),
    suspectAt: row.suspect_at,
    suspectReason: row.suspect_reason,
    revokedAt: row.revoked_at,
    pause:
      row.paused_until !== null && row.pause_reason !== null
        ? { reason: row.pause_reason, until: row.paused_until }
        : null,
  };
}

function toEnrolment(row: EnrolmentRow): EnrolmentRecord {
  return {
    codeHash: row.code_hash,
    accountId: row.account_id,
    name: row.name,
    projectScope: row.project_scope,
    allowedProjects: stringList(row.allowed_projects),
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedByRunnerId: row.used_by_runner_id,
    usedAt: row.used_at,
  };
}

/**
 * The condition a runner row is written under, judged by the INSERT itself: a subquery the row is written only if it
 * `EXISTS`. Its own placeholders are plain `?`, numbered by SQLite after the row's `?1`–`?13`; it may name `?2` (the
 * account) and `?10` (the enrolment time).
 */
export interface RunnerInsertGate {
  readonly exists: string;
  readonly params: readonly (string | number | null)[];
}

/**
 * The one INSERT every enrolment door writes a runner with (the one-time code, and the enrolment intent of #634), so
 * the two can never drift apart in what a runner row holds. Module-internal to `@worker/db`: only a repo that marks
 * its own credential used in the same batch may call it.
 */
export function runnerInsertStatement(
  db: D1Database,
  runner: NewRunner,
  hosted: boolean,
  gate: RunnerInsertGate,
): D1PreparedStatement {
  const hostedRefusal = hosted ? `AND NOT ${hostedEnrolmentRefusedSql('?2', '?1')}` : '';
  // R-SCOPE-4: a hosted runner is created `selected` with what the server declares for it, whatever the code says;
  // its scope is never widened to `all` (`setScope` refuses it too).
  const scope: RunnerProjectScopeDto = hosted
    ? { projectScope: 'selected', allowedProjects: runner.allowedProjects }
    : { projectScope: runner.projectScope, allowedProjects: runner.allowedProjects };
  const capabilities: RunnerCapabilitiesDto = hosted
    ? { ...runner.capabilities, accessSources: SERVER_SET_ACCESS_SOURCES }
    : runner.capabilities;
  return db
    .prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, host, capabilities, isolation, allowed_projects, version, enrolled_at, hosted, project_scope, enrolled_by)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       WHERE EXISTS (${gate.exists}) ${hostedRefusal}`,
    )
    .bind(
      runner.id,
      runner.accountId,
      runner.name,
      JSON.stringify(runner.publicKeyJwk),
      JSON.stringify(runner.host),
      JSON.stringify(capabilities),
      runner.isolation,
      JSON.stringify(scope.allowedProjects),
      runner.version,
      runner.at,
      hosted ? 1 : 0,
      scope.projectScope,
      runner.enrolledBy,
      ...gate.params,
    );
}

/** `availabilityOf`'s best runner level, as its statement ranks them. */
const AVAILABILITY_BY_LEVEL: readonly RunnerAvailability[] = ['none', 'offline', 'paused', 'ready'];

export class RunnersRepo {
  constructor(private readonly db: D1Database) {}

  /** The one-time code's row (its hash, never the code) with the audit row of its creation, in one batch. */
  async createEnrolment(enrolment: NewEnrolment, audit: NewAuditEvent): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO runner_enrolments (code_hash, account_id, name, project_scope, allowed_projects, created_by, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?8, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          enrolment.codeHash,
          enrolment.accountId,
          enrolment.name,
          JSON.stringify(enrolment.allowedProjects),
          enrolment.createdBy,
          enrolment.at,
          enrolment.expiresAt,
          enrolment.projectScope,
        ),
      auditEventStatement(this.db, audit),
    ]);
  }

  /** The account's codes that can still enrol a runner at `now` (unused, not expired), oldest first. */
  async listPendingEnrolments(accountId: string, now: string): Promise<EnrolmentRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${ENROLMENT_COLUMNS}
         FROM runner_enrolments
         WHERE account_id = ?1 AND used_by_runner_id IS NULL AND julianday(expires_at) > julianday(?2)
         ORDER BY created_at, code_hash`,
      )
      .bind(accountId, now)
      .all<EnrolmentRow>();
    return results.map(toEnrolment);
  }

  /**
   * Withdraws a pending code of `accountId` before it expires (#492): the row goes, so the code's hash matches nothing
   * and `enrol` answers it as unknown. `false` when the code is another account's, used, expired or already gone. The
   * audit row is written only when this call deleted the row. An enrol racing this either won first (the DELETE
   * finds a used row) or finds no row; D1 runs one batch at a time.
   */
  async withdrawEnrolment(
    accountId: string,
    codeHash: string,
    now: string,
    audit: NewAuditEvent,
  ): Promise<boolean> {
    const [deleted] = await this.db.batch([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `DELETE FROM runner_enrolments
             WHERE code_hash = ?1 AND account_id = ?2 AND used_by_runner_id IS NULL AND julianday(expires_at) > julianday(?3)`,
          )
          .bind(codeHash, accountId, now),
        audit,
      ),
    ]);
    return (deleted?.meta.changes ?? 0) === 1;
  }

  async findEnrolment(codeHash: string): Promise<EnrolmentRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${ENROLMENT_COLUMNS} FROM runner_enrolments WHERE code_hash = ?1`)
      .bind(codeHash)
      .first<EnrolmentRow>();
    return row === null ? null : toEnrolment(row);
  }

  /**
   * The runner row, the code's single use and the `runner.enrolled` audit row in one batch. `code-used` when another
   * enrol request won the code first (the 0021 trigger refuses the second use) or the owner withdrew it since the
   * route's lookup, or the code expired at `runner.at` since that lookup (#531); either way nothing was written, the
   * audit row included.
   */
  async enrol(codeHash: string, runner: NewRunner, audit: NewAuditEvent): Promise<'ok' | 'code-used'> {
    const outcome = await this.enrolOnCode(codeHash, runner, false, audit);
    // A self-hosted runner never meets the hosted refusal: its INSERT carries no such condition.
    return outcome === 'access-source-hosted' ? 'code-used' : outcome;
  }

  /**
   * `enrol` for a console-hosted runner (`runners.hosted = 1`, H-2). `access-source-hosted` (ADR 0009 d.3, #707) when
   * the effective placement of one of the account's `subscription` projects would admit the new runner: judged by
   * the INSERT itself, so nothing is written then, the code's use and the audit row included. No route enrols a hosted
   * runner yet; this is the write H-2 must go through.
   */
  async enrolHosted(codeHash: string, runner: NewRunner, audit: NewAuditEvent): Promise<HostedEnrolOutcome> {
    return this.enrolOnCode(codeHash, runner, true, audit);
  }

  private async enrolOnCode(
    codeHash: string,
    runner: NewRunner,
    hosted: boolean,
    audit: NewAuditEvent,
  ): Promise<HostedEnrolOutcome> {
    let results: D1Result[];
    try {
      results = await this.db.batch([
        // The runner row only while the code is still unused; the UPDATE below then marks it used, and the 0021
        // trigger aborts the whole batch when another request used it first (the WHERE names the row, not its state,
        // so the trigger sees the second use).
        runnerInsertStatement(this.db, runner, hosted, {
          exists: `SELECT 1 FROM runner_enrolments
                   WHERE code_hash = ? AND used_by_runner_id IS NULL AND julianday(expires_at) > julianday(?10)`,
          params: [codeHash],
        }),
        // #522: the audit row only when this UPDATE marked the code, so a code withdrawn after the route's lookup
        // (both statements above then find no row) leaves no `runner.enrolled` row behind. #531: the expiry is judged
        // here too, at the same `now` as the INSERT, so a code that expired after the route's check is left unused
        // rather than pointed at a runner that was never written. #707: a hosted enrolment marks the code only once
        // its runner row exists, so the placement refusal leaves the code unused for a retry after the owner fixes it.
        ...auditedWrite(
          this.db,
          this.db
            .prepare(
              `UPDATE runner_enrolments SET used_by_runner_id = ?2, used_at = ?3
               WHERE code_hash = ?1 AND julianday(expires_at) > julianday(?3)
               ${hosted ? 'AND EXISTS (SELECT 1 FROM runners WHERE id = ?2)' : ''}`,
            )
            .bind(codeHash, runner.id, runner.at),
          audit,
        ),
      ]);
    } catch (error: unknown) {
      if (isConstraintError(error, 'an enrolment code is used once')) {
        return 'code-used';
      }
      throw error;
    }
    // No row updated: the code is gone, withdrawn by the owner since the route looked it up (#492), or expired since
    // (#531). Nothing was written; the caller answers it like a used code.
    if ((results[1]?.meta.changes ?? 0) === 1) {
      return 'ok';
    }
    if (!hosted) {
      return 'code-used';
    }
    // The INSERT judged it; this read only names which refusal held. A code that is no longer usable answers as
    // `code-used` first, as the self-hosted path does, so the placement is named only to a holder of a live code.
    const refused = await this.db
      .prepare(
        `SELECT EXISTS (
           SELECT 1 FROM runner_enrolments
           WHERE code_hash = ?3 AND used_by_runner_id IS NULL AND julianday(expires_at) > julianday(?4)
         ) AND ${hostedEnrolmentRefusedSql('?2', '?1')} AS hit`,
      )
      .bind(runner.id, runner.accountId, codeHash, runner.at)
      .first<{ hit: number }>();
    return refused?.hit === 1 ? 'access-source-hosted' : 'code-used';
  }

  async findById(id: string): Promise<RunnerRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${RUNNER_COLUMNS} FROM runners WHERE id = ?1`)
      .bind(id)
      .first<RunnerRow>();
    return row === null ? null : toRecord(row);
  }

  /** A runner of `accountId` by id: another account's runner is `null`, the same as one that does not exist. */
  async findInAccount(accountId: string, id: string): Promise<RunnerRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${RUNNER_COLUMNS} FROM runners WHERE id = ?1 AND account_id = ?2`)
      .bind(id, accountId)
      .first<RunnerRow>();
    return row === null ? null : toRecord(row);
  }

  async listForAccount(accountId: string): Promise<RunnerRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${RUNNER_COLUMNS} FROM runners WHERE account_id = ?1 ORDER BY enrolled_at, id`)
      .bind(accountId)
      .all<RunnerRow>();
    return results.map(toRecord);
  }

  /** The ids of the account's unrevoked runners, for a placement policy's check. */
  async liveIdsOf(accountId: string): Promise<readonly string[]> {
    const { results } = await this.db
      .prepare(`SELECT id FROM runners WHERE account_id = ?1 AND revoked_at IS NULL`)
      .bind(accountId)
      .all<{ id: string }>();
    return results.map((row) => row.id);
  }

  /** `false` when the runner is not the account's or is already revoked (the 0021 trigger keeps the first time). */
  async revoke(
    accountId: string,
    id: string,
    at: string,
    audit: NewAuditEvent,
    alsoInBatch: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    // #531: the audit row sits right after the revoke and is written only when it revoked, so of two racing revokes
    // only the winner audits; the extra statements come after the pair, never between.
    const [update] = await this.db.batch<{ id: string }>([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runners SET revoked_at = ?3 WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL RETURNING id`,
          )
          .bind(id, accountId, at),
        audit,
      ),
      ...alsoInBatch,
    ]);
    // RETURNING, not `meta.changes`: D1 counts the rows the 0023 trigger revokes in role_keys there too.
    return (update?.results.length ?? 0) === 1;
  }

  /**
   * The owner clears a runner's suspect mark (#492, threat model C4). `false` when the runner is not the account's,
   * is revoked or is not marked (anymore). The write is conditional on the mark, so of two clears only one audits. The
   * next sighting judges the runner afresh: a second poller still there marks it again.
   */
  async clearSuspect(accountId: string, id: string, audit: NewAuditEvent): Promise<boolean> {
    const [update] = await this.db.batch([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runners SET suspect_at = NULL, suspect_reason = NULL
             WHERE id = ?1 AND account_id = ?2 AND suspect_at IS NOT NULL AND revoked_at IS NULL`,
          )
          .bind(id, accountId),
        audit,
      ),
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }

  /**
   * The runner's scope (#775): `all`, or `selected` with its list, set by the owner whose audit actor is `by`.
   * `changed` only when something changed. `unchanged` when the runner is not the account's, is hosted or
   * `actions-ephemeral` (R-SCOPE-4: those are never widened; the route answers 422 before this, the WHERE holds it in
   * the write), or already holds exactly this scope: that write changes no row, audits nothing and cancels nothing
   * (#533). "The same list" is set equality (#547): order and duplicates do not count as a change. The list was checked
   * against the account's projects by the caller; under `all` it is `[]`.
   *
   * `enroller-only` (#795, owner decision (a)): on a runner that can serve a subscription, only the owner who enrolled
   * it may give it a project it does not serve now — another owner may only narrow, since the subscription is the
   * enroller's. Judged in the batch on the stored row, with the claim's own term (`runnerServesSql`), so a change that
   * commits in between cannot slip past it.
   */
  async setScope(
    accountId: string,
    id: string,
    scope: RunnerProjectScopeDto,
    by: string,
    audit: NewAuditEvent,
    alsoInBatch: readonly D1PreparedStatement[] = [],
  ): Promise<ScopeWrite> {
    const list = JSON.stringify(scope.projectScope === 'all' ? [] : [...new Set(scope.allowedProjects)]);
    const mayWrite = scopeWriteAllowedSql('runners');
    // #531: as in `revoke`, the audit row only for a write that happened, the extra statements after the pair.
    const [refusal, update] = await this.db.batch<{ id: string; refused?: number }>([
      this.db
        .prepare(`SELECT id, NOT ${mayWrite} AS refused FROM runners WHERE id = ?1 AND account_id = ?2`)
        .bind(id, accountId, list, scope.projectScope, by),
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runners SET project_scope = ?4, allowed_projects = ?3,
               non_enroller_projects = ${nonEnrollerProjectsAfterWriteSql('runners')}
             WHERE id = ?1 AND account_id = ?2 AND hosted = 0 AND isolation <> 'actions-ephemeral' AND (
               project_scope <> ?4
               OR EXISTS (SELECT 1 FROM json_each(?3) n WHERE n.value NOT IN (SELECT value FROM json_each(runners.allowed_projects)))
               OR EXISTS (SELECT 1 FROM json_each(runners.allowed_projects) o WHERE o.value NOT IN (SELECT value FROM json_each(?3)))
             ) AND ${mayWrite} RETURNING id`,
          )
          .bind(id, accountId, list, scope.projectScope, by),
        audit,
      ),
      ...alsoInBatch,
    ]);
    // RETURNING, not `meta.changes`: D1 counts the rows the 0023 trigger revokes in role_keys there too.
    if ((update?.results.length ?? 0) === 1) {
      return 'changed';
    }
    return refusal?.results[0]?.refused === 1 ? 'enroller-only' : 'unchanged';
  }

  /**
   * The sole owner records themselves as the enroller of a runner from before `enrolled_by` (#827, owner decision (a)),
   * so D3 and #795 treat it as theirs once a second owner joins. Only NULL→`by` (the 0036 trigger refuses any change of
   * a recorded enroller). The sole-owner rule is a term of the UPDATE itself, so an owner joining between the route's
   * read and this write leaves the row untouched; the read before it in the batch only words the refusal.
   *
   * `userId` NULL is the local bypass alone; the route refuses the Access owner before the link (#837), so a claim
   * never writes `access-owner` here. Rows that hold it from before are handed to the user when the link is written
   * (#838, migration 0042: a trigger on `users.access_subject`, audited `auth.access-actor-adopted`, the one exception
   * to the 0036 trigger; #899, migration 0044: only to a linked user who is a member of the owner account). A future
   * link route writes the link first and writes no such audit row of its own.
   */
  async claimEnroller(
    accountId: string,
    id: string,
    by: string,
    userId: string | null,
    audit: NewAuditEvent,
  ): Promise<EnrollerClaim> {
    const soleOwner = claimerIsSoleOwnerSql('runners', '?4');
    const [diagnosis, update] = await this.db.batch<{
      id: string;
      recorded?: number;
      revoked?: number;
      fixed?: number;
      sole?: number;
    }>([
      this.db
        .prepare(
          `SELECT id, enrolled_by IS NOT NULL AS recorded, revoked_at IS NOT NULL AS revoked,
             (hosted = 1 OR isolation = 'actions-ephemeral') AS fixed, ${soleOwner} AS sole
           FROM runners WHERE id = ?1 AND account_id = ?2`,
        )
        .bind(id, accountId, by, userId),
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runners SET enrolled_by = ?3
             WHERE id = ?1 AND account_id = ?2 AND ${enrollerOpenSql('runners')} AND ${soleOwner} RETURNING id`,
          )
          .bind(id, accountId, by, userId),
        audit,
      ),
    ]);
    if ((update?.results.length ?? 0) === 1) {
      return 'claimed';
    }
    const row = diagnosis?.results[0];
    if (row === undefined) {
      return 'not-found';
    }
    if (row.recorded === 1) {
      return 'already-set';
    }
    if (row.revoked === 1) {
      return 'revoked';
    }
    if (row.fixed === 1) {
      return 'fixed';
    }
    if (row.sole !== 1) {
      return 'not-sole-owner';
    }
    // The batch is one transaction: a row that passed every term in the read was not left untouched by the write.
    throw new Error('claimEnroller: the claim wrote nothing, yet the row passes every term');
  }

  /** The account's runners whose enroller the claimer may claim now (#827), by the write's own terms. */
  async enrollerClaimableIdsOf(accountId: string, userId: string | null): Promise<readonly string[]> {
    const rows = await this.db
      .prepare(
        `SELECT id FROM runners WHERE account_id = ?1 AND ${enrollerOpenSql('runners')} AND ${claimerIsSoleOwnerSql('runners', '?2')}`,
      )
      .bind(accountId, userId)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  /**
   * Records what the runner declares its credential can serve (#775, SECURITY question 7), from the claim poll.
   * Self-hosted, unrevoked runners only: a hosted or `actions-ephemeral` identity keeps the server's value whatever it
   * sends. `false` when nothing changed. The declaration only narrows the claim, so the runner's own say-so costs at
   * most the runner's own jobs.
   *
   * A switch to a subscription narrows what D3 lets the runner serve (#824: `all`, and the entries another owner
   * added), so `alsoInBatch` carries the cancel of the live jobs it no longer serves, as a scope write does (#533).
   * Those statements read `changes()` of this write, so they run only for a declaration that changed the row.
   */
  async setAccessSources(
    id: string,
    accessSources: readonly AccessSource[],
    alsoInBatch: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const declared = JSON.stringify([...accessSources].sort());
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE runners SET capabilities = json_set(capabilities, '$.accessSources', json(?2))
           WHERE id = ?1 AND hosted = 0 AND isolation <> 'actions-ephemeral' AND revoked_at IS NULL
             AND (json_type(capabilities, '$.accessSources') IS NULL OR json_extract(capabilities, '$.accessSources') <> json(?2))`,
        )
        .bind(id, declared),
      ...alsoInBatch,
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }

  /**
   * Stores the runner's check declaration (#1059, S1) under the constant path `$.checks`, leaving every other
   * capability key as it is, and only when it changed (`false` then, and for a hosted, `actions-ephemeral` or revoked
   * identity, whose declaration is ignored by the write itself). It gates enqueue only, never delivery.
   */
  async setChecks(id: string, checks: readonly RunnerCheckKind[]): Promise<boolean> {
    const declared = JSON.stringify([...checks].sort());
    const result = await this.db
      .prepare(
        `UPDATE runners SET capabilities = json_set(capabilities, '$.checks', json(?2))
         WHERE id = ?1 AND hosted = 0 AND isolation <> 'actions-ephemeral' AND revoked_at IS NULL
           AND (json_type(capabilities, '$.checks') IS NULL OR json_extract(capabilities, '$.checks') <> json(?2))`,
      )
      .bind(id, declared)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * The active projects each unrevoked runner of `accountId` serves now (#775): the claim's own project term
   * (`runnerServesSql`, D3 applied) inside the account, so Settings › Runners and `/runner/self` show the answer the
   * claim would give. `runnerId` narrows it to one runner. Slug order within a runner.
   */
  async servedProjectsOf(accountId: string, runnerId: string | null = null): Promise<ServedProjectRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.id AS runner_id, p.slug, p.access_source
         FROM runners r JOIN projects p ON p.account_id = r.account_id
         WHERE r.account_id = ?1 AND (?2 IS NULL OR r.id = ?2) AND r.revoked_at IS NULL AND p.archived_at IS NULL
           AND ${runnerServesSql('r', 'p.slug')}
         ORDER BY r.id, p.slug`,
      )
      .bind(accountId, runnerId)
      .all<{ runner_id: string; slug: string; access_source: string }>();
    return results
      .filter((row) => isAccessSource(row.access_source))
      .map((row) => ({
        runnerId: row.runner_id,
        slug: row.slug,
        accessSource: row.access_source as AccessSource,
      }));
  }

  /**
   * #799: per unrevoked runner of `accountId`, the active projects its scope covers that D3 holds back only because the
   * console does not know whose they are — the project has no creator, or the runner no enroller (rows from before
   * 0036 that migration 0048 could not attribute). The claim's own term decides what is held back; runners with none
   * are left out. `runnerId` narrows it to one runner. Against a NULL creator the term is NULL rather than false, so
   * the negation is taken over its COALESCE.
   */
  async unattributedProjectCountsOf(
    accountId: string,
    runnerId: string | null = null,
  ): Promise<ReadonlyMap<string, number>> {
    const { results } = await this.db
      .prepare(
        `SELECT r.id AS runner_id, COUNT(*) AS n
         FROM runners r JOIN projects p ON p.account_id = r.account_id
         WHERE r.account_id = ?1 AND (?2 IS NULL OR r.id = ?2) AND r.revoked_at IS NULL AND p.archived_at IS NULL
           AND (p.created_by IS NULL OR r.enrolled_by IS NULL)
           AND ${runnerScopeCoversSql('r', 'p.slug')} AND NOT COALESCE(${runnerServesSql('r', 'p.slug')}, 0)
         GROUP BY r.id`,
      )
      .bind(accountId, runnerId)
      .all<{ runner_id: string; n: number }>();
    return new Map(results.map((row) => [row.runner_id, row.n]));
  }

  /**
   * Whether a Run now of `slug` could be claimed at `now` (#775): the claim's runner terms, read for every unrevoked
   * runner of the project's account — the account equality, `runnerServesSql` (D3 applied), the access-source fit, the
   * claim's placement term and its `needs_local` term — then the best of them: online and not paused, online but
   * paused, or seen too long ago. A suspended account or an archived project claims nothing, so it is `none`; an Actions
   * project needs no runner (#670) but for a `needs_local` job, so it is `ready`. A paused team (`team_state`, #810) turns `ready` into
   * `team-paused`: the claim and the Actions dispatch take nothing while it holds, but a runner that is offline,
   * paused or missing is still the answer, since resuming alone would not start the job then.
   *
   * `needsLocal` is the job's flag. Run now never sets it (its body is the kind alone), hence the default; a
   * `needs_local` job is claimed only by a runner whose stored `capabilities.local` is true, which is what the claim's
   * `request.local` reads (#810). What it leaves to the claim is transient: the runner's free slots, the role's
   * `max_parallel`, the budget and the account's concurrency, which make a job wait, not fail to start.
   */
  async availabilityOf(slug: string, now: string, needsLocal = false): Promise<RunnerAvailability> {
    const row = await this.db
      .prepare(
        `SELECT p.dispatch, (a.suspended_at IS NULL AND p.archived_at IS NULL) AS live,
           (t.paused_at IS NULL) AS team_running,
           MAX(CASE
                 WHEN r.id IS NULL THEN 0
                 WHEN r.last_seen_at IS NULL OR (julianday(?2) - julianday(r.last_seen_at)) * 86400.0 > ?3 THEN 1
                 WHEN r.paused_until IS NOT NULL AND julianday(r.paused_until) > julianday(?2) THEN 2
                 ELSE 3
               END) AS level
         FROM projects p JOIN accounts a ON a.id = p.account_id
         LEFT JOIN team_state t ON t.project_slug = p.slug
         LEFT JOIN runners r ON r.account_id = p.account_id AND r.revoked_at IS NULL
           AND r.isolation <> 'actions-ephemeral'
           AND (?5 = 0 OR json_extract(r.capabilities, '$.local') = 1)
           AND ${runnerServesSql('r', 'p.slug')}
           AND ${runnerFitsAccessSourceSql('r', 'p')}
           AND ${claimPlacementAdmitsSql('COALESCE(p.runner_policy, a.default_runner_policy)', 'r.id', '?2', '?4')}
         WHERE p.slug = ?1
         GROUP BY p.slug`,
      )
      .bind(slug, now, RUNNER_ONLINE_WINDOW_SECONDS, RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS, needsLocal ? 1 : 0)
      .first<{ dispatch: string; live: number; team_running: number; level: number }>();
    if (row === null || row.live !== 1) {
      return 'none';
    }
    const availability =
      // A `needs_local` job of an Actions project stays `pull` (#695), so a runner takes it.
      row.dispatch === 'actions' && !needsLocal ? 'ready' : (AVAILABILITY_BY_LEVEL[row.level] ?? 'none');
    return availability === 'ready' && row.team_running !== 1 ? 'team-paused' : availability;
  }

  /**
   * Why no runner may serve `slug` (#775), for the owner's eyes only: the caller asks it only for an owner and only
   * when `availabilityOf` said `none`. Each reason is the claim's runner terms with one of them turned around: a runner
   * that serves the project and its placement admits but whose access sources do not fit it (`access-mismatch`, told
   * first, since the owner fixes it on the runner or the team configuration), or one D3 alone holds back
   * (`other-owner-subscription`). Otherwise `no-runner`.
   */
  async unavailableReasonOf(slug: string, now: string): Promise<RunnerUnavailableReason> {
    const candidate = `FROM runners r WHERE r.account_id = p.account_id AND r.revoked_at IS NULL
             AND r.isolation <> 'actions-ephemeral'
             AND ${claimPlacementAdmitsSql('COALESCE(p.runner_policy, a.default_runner_policy)', 'r.id', '?2', '?3')}`;
    const row = await this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 ${candidate} AND ${runnerServesSql('r', 'p.slug')}
                   AND NOT (${runnerFitsAccessSourceSql('r', 'p')})) AS mismatch,
           EXISTS (SELECT 1 ${candidate} AND ${runnerScopeCoversSql('r', 'p.slug')} AND NOT ${runnerServesSql('r', 'p.slug')}
                   AND ${runnerFitsAccessSourceSql('r', 'p')}) AS held_by_d3
         FROM projects p JOIN accounts a ON a.id = p.account_id
         WHERE p.slug = ?1`,
      )
      .bind(slug, now, RUNNER_POLICY_OFFLINE_DEFAULT_SECONDS)
      .first<{ mismatch: number; held_by_d3: number }>();
    if (row?.mismatch === 1) {
      return 'access-mismatch';
    }
    return row?.held_by_d3 === 1 ? 'other-owner-subscription' : 'no-runner';
  }

  /** The unrevoked `all` runners of `accountId` that serve `slug` now (R-SCOPE-2: audited when a project appears). */
  async allScopeRunnersServing(accountId: string, slug: string): Promise<readonly string[]> {
    const served = await this.servedProjectsOf(accountId);
    const all = new Set(
      (await this.listForAccount(accountId))
        .filter((runner) => runner.projectScope === 'all' && runner.revokedAt === null)
        .map((runner) => runner.id),
    );
    return served.filter((row) => row.slug === slug && all.has(row.runnerId)).map((row) => row.runnerId);
  }

  /**
   * The runner's own pause (#571, ADR 0008 decision 9): the claim takes nothing for it until `until`. `false` when the
   * runner is not the account's, is revoked, or already holds exactly this pause — a repeated post (a restart that
   * mirrors its `state.json` again) writes and audits nothing. `until` was checked against `now` by the caller.
   */
  async pause(
    accountId: string,
    id: string,
    pause: { readonly reason: RunnerPauseReason; readonly until: string },
    audit: NewAuditEvent,
  ): Promise<boolean> {
    const [update] = await this.db.batch<{ id: string }>([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runners SET paused_until = ?3, pause_reason = ?4
             WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL
               AND (paused_until IS NOT ?3 OR pause_reason IS NOT ?4)
             RETURNING id`,
          )
          .bind(id, accountId, pause.until, pause.reason),
        audit,
      ),
    ]);
    return (update?.results.length ?? 0) === 1;
  }

  /**
   * Lifts the runner's pause before its time (#571): the runner ran a job again, or its local pause lapsed. `false`
   * when the runner is not the account's, is revoked, or holds no pause row; a lapsed pause is cleared too, so the
   * row never keeps a stale reason.
   */
  async resume(accountId: string, id: string, audit: NewAuditEvent): Promise<boolean> {
    const [update] = await this.db.batch<{ id: string }>([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runners SET paused_until = NULL, pause_reason = NULL
             WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL AND paused_until IS NOT NULL
             RETURNING id`,
          )
          .bind(id, accountId),
        audit,
      ),
    ]);
    return (update?.results.length ?? 0) === 1;
  }

  /**
   * Records a runner's call (presence) and judges it against the previous one (threat model C4, "Detection"): a
   * country the runner has never called from, or a second source address inside one lease window, marks the runner
   * suspect once — until the owner clears it (2-E) — and the caller audits the alert. One read, one write: a race
   * between two calls of the same runner costs at most a duplicate alert, never a missed one.
   */
  async sight(
    id: string,
    sighting: RunnerSighting,
    audit: (alert: RunnerSuspectReason) => NewAuditEvent,
  ): Promise<SightingOutcome> {
    const runner = await this.findById(id);
    if (runner === null) {
      return { alert: null, previousCountry: null };
    }
    const seenCountries =
      sighting.country !== null && !runner.seenCountries.includes(sighting.country)
        ? [...runner.seenCountries, sighting.country]
        : runner.seenCountries;
    const newCountry =
      sighting.country !== null &&
      runner.seenCountries.length > 0 &&
      !runner.seenCountries.includes(sighting.country);
    const withinWindow =
      runner.lastSeenAt !== null &&
      Date.parse(sighting.at) - Date.parse(runner.lastSeenAt) <= TWO_POLLERS_WINDOW_MS;
    const twoPollers =
      sighting.ipHash !== null &&
      runner.lastSeenIpHash !== null &&
      runner.lastSeenIpHash !== sighting.ipHash &&
      withinWindow;
    // #668: an ephemeral Actions identity calls from whatever egress GitHub gives the run, so neither rule applies; it
    // lives for one job on one VM and is revoked with it.
    const judged = runner.suspectAt === null && runner.isolation !== 'actions-ephemeral';
    const alert: RunnerSuspectReason | null = !judged
      ? null
      : twoPollers
        ? 'two-pollers'
        : newCountry
          ? 'new-country'
          : null;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE runners SET last_seen_at = ?2, last_seen_country = ?3, last_seen_ip_hash = ?4, seen_countries = ?5,
             suspect_at = COALESCE(suspect_at, ?6), suspect_reason = COALESCE(suspect_reason, ?7)
           WHERE id = ?1`,
        )
        .bind(
          id,
          sighting.at,
          sighting.country,
          sighting.ipHash,
          JSON.stringify(seenCountries),
          alert === null ? null : sighting.at,
          alert,
        ),
    ];
    if (alert !== null) {
      statements.push(auditEventStatement(this.db, audit(alert)));
    }
    await this.db.batch(statements);
    return { alert, previousCountry: runner.lastSeenCountry };
  }

  /**
   * Records a runner JWT's `jti` until its `exp`; `false` when it was presented before (replay). Expired rows are
   * swept in the same batch, so the table stays the size of one window per runner.
   */
  async consumeNonce(runnerId: string, jti: string, expiresAt: string, now: string): Promise<boolean> {
    const [, insert] = await this.db.batch([
      this.db.prepare(`DELETE FROM runner_nonces WHERE expires_at < ?1`).bind(now),
      this.db
        .prepare(`INSERT OR IGNORE INTO runner_nonces (runner_id, jti, expires_at) VALUES (?1, ?2, ?3)`)
        .bind(runnerId, jti, expiresAt),
    ]);
    return (insert?.meta.changes ?? 0) === 1;
  }
}
