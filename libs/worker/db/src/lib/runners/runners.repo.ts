import type {
  Ed25519PublicJwk,
  RunnerCapabilitiesDto,
  RunnerHostDto,
  RunnerIsolation,
  RunnerSuspectReason,
} from '@shared/contracts';
import { WROTE_PREVIOUS_STATEMENT, auditEventStatement, type NewAuditEvent } from '../accounts/audit.repo';
import { isConstraintError } from '../tracker/constraint-error';

/**
 * Runners and their enrolment codes (#467, ADR 0008 row 2-A, migration 0021). Every write names the account it acts
 * in, so a runner of account A is never read, revoked or re-scoped through account B's routes; the audit row of a
 * change travels in the change's own batch.
 */

export interface RunnerRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly hosted: boolean;
  readonly isolation: RunnerIsolation;
  readonly allowedProjects: readonly string[];
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
}

export interface EnrolmentRecord {
  readonly codeHash: string;
  readonly accountId: string;
  readonly name: string;
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
  readonly allowedProjects: readonly string[];
  readonly version: string;
  readonly at: string;
}

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
  allowed_projects: string;
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
}

interface EnrolmentRow {
  code_hash: string;
  account_id: string;
  name: string;
  allowed_projects: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_by_runner_id: string | null;
  used_at: string | null;
}

const RUNNER_COLUMNS = `id, account_id, name, public_key_jwk, host, capabilities, hosted, isolation, allowed_projects,
  version, pinned_version, enrolled_at, last_seen_at, last_seen_country, last_seen_ip_hash, seen_countries,
  suspect_at, suspect_reason, revoked_at`;

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
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    publicKeyJwk: JSON.parse(row.public_key_jwk) as Ed25519PublicJwk,
    host: { os: host.os ?? '', arch: host.arch ?? '', hostname: host.hostname ?? '' },
    capabilities: { local: capabilities.local === true, maxConcurrency: capabilities.maxConcurrency ?? 1 },
    hosted: row.hosted === 1,
    isolation: row.isolation,
    allowedProjects: stringList(row.allowed_projects),
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
  };
}

function toEnrolment(row: EnrolmentRow): EnrolmentRecord {
  return {
    codeHash: row.code_hash,
    accountId: row.account_id,
    name: row.name,
    allowedProjects: stringList(row.allowed_projects),
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedByRunnerId: row.used_by_runner_id,
    usedAt: row.used_at,
  };
}

export class RunnersRepo {
  constructor(private readonly db: D1Database) {}

  /** The one-time code's row (its hash, never the code) with the audit row of its creation, in one batch. */
  async createEnrolment(enrolment: NewEnrolment, audit: NewAuditEvent): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO runner_enrolments (code_hash, account_id, name, allowed_projects, created_by, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          enrolment.codeHash,
          enrolment.accountId,
          enrolment.name,
          JSON.stringify(enrolment.allowedProjects),
          enrolment.createdBy,
          enrolment.at,
          enrolment.expiresAt,
        ),
      auditEventStatement(this.db, audit),
    ]);
  }

  /** The account's codes that can still enrol a runner at `now` (unused, not expired), oldest first. */
  async listPendingEnrolments(accountId: string, now: string): Promise<EnrolmentRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT code_hash, account_id, name, allowed_projects, created_by, created_at, expires_at, used_by_runner_id, used_at
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
  async withdrawEnrolment(accountId: string, codeHash: string, now: string, audit: NewAuditEvent): Promise<boolean> {
    const [deleted] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM runner_enrolments
           WHERE code_hash = ?1 AND account_id = ?2 AND used_by_runner_id IS NULL AND julianday(expires_at) > julianday(?3)`,
        )
        .bind(codeHash, accountId, now),
      auditEventStatement(this.db, audit, WROTE_PREVIOUS_STATEMENT),
    ]);
    return (deleted?.meta.changes ?? 0) === 1;
  }

  async findEnrolment(codeHash: string): Promise<EnrolmentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT code_hash, account_id, name, allowed_projects, created_by, created_at, expires_at, used_by_runner_id, used_at
         FROM runner_enrolments WHERE code_hash = ?1`,
      )
      .bind(codeHash)
      .first<EnrolmentRow>();
    return row === null ? null : toEnrolment(row);
  }

  /**
   * The runner row, the code's single use and the `runner.enrolled` audit row in one batch. `code-used` when another
   * enrol request won the code first (the 0021 trigger refuses the second use), so nothing was written.
   */
  async enrol(codeHash: string, runner: NewRunner, audit: NewAuditEvent): Promise<'ok' | 'code-used'> {
    let results: D1Result[];
    try {
      results = await this.db.batch([
        // The runner row only while the code is still unused; the UPDATE below then marks it used, and the 0021
        // trigger aborts the whole batch when another request used it first (the WHERE names the row, not its state,
        // so the trigger sees the second use).
        this.db
          .prepare(
            `INSERT INTO runners (id, account_id, name, public_key_jwk, host, capabilities, isolation, allowed_projects, version, enrolled_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             WHERE EXISTS (SELECT 1 FROM runner_enrolments WHERE code_hash = ?11 AND used_by_runner_id IS NULL)`,
          )
          .bind(
            runner.id,
            runner.accountId,
            runner.name,
            JSON.stringify(runner.publicKeyJwk),
            JSON.stringify(runner.host),
            JSON.stringify(runner.capabilities),
            runner.isolation,
            JSON.stringify(runner.allowedProjects),
            runner.version,
            runner.at,
            codeHash,
          ),
        this.db
          .prepare(`UPDATE runner_enrolments SET used_by_runner_id = ?2, used_at = ?3 WHERE code_hash = ?1`)
          .bind(codeHash, runner.id, runner.at),
        auditEventStatement(this.db, audit),
      ]);
    } catch (error: unknown) {
      if (isConstraintError(error, 'an enrolment code is used once')) {
        return 'code-used';
      }
      throw error;
    }
    // No row updated: the code does not exist (the route checked, so a race deleted nothing — it cannot); treat as used.
    return (results[1]?.meta.changes ?? 0) === 1 ? 'ok' : 'code-used';
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
    const [update] = await this.db.batch<{ id: string }>([
      this.db
        .prepare(
          `UPDATE runners SET revoked_at = ?3 WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL RETURNING id`,
        )
        .bind(id, accountId, at),
      ...alsoInBatch,
      auditEventStatement(this.db, audit),
    ]);
    return (update?.results.length ?? 0) === 1;
  }

  /**
   * The owner clears a runner's suspect mark (#492, threat model C4). `false` when the runner is not the account's,
   * is revoked or is not marked (anymore). The write is conditional on the mark, so of two clears only one audits. The
   * next sighting judges the runner afresh: a second poller still there marks it again.
   */
  async clearSuspect(accountId: string, id: string, audit: NewAuditEvent): Promise<boolean> {
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE runners SET suspect_at = NULL, suspect_reason = NULL
           WHERE id = ?1 AND account_id = ?2 AND suspect_at IS NOT NULL AND revoked_at IS NULL`,
        )
        .bind(id, accountId),
      auditEventStatement(this.db, audit, WROTE_PREVIOUS_STATEMENT),
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }

  /** `false` when the runner is not the account's. The list was checked against the account's projects by the caller. */
  async setAllowedProjects(
    accountId: string,
    id: string,
    allowedProjects: readonly string[],
    audit: NewAuditEvent,
    alsoInBatch: readonly D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const [update] = await this.db.batch<{ id: string }>([
      this.db
        .prepare(`UPDATE runners SET allowed_projects = ?3 WHERE id = ?1 AND account_id = ?2 RETURNING id`)
        .bind(id, accountId, JSON.stringify(allowedProjects)),
      ...alsoInBatch,
      auditEventStatement(this.db, audit),
    ]);
    return (update?.results.length ?? 0) === 1;
  }

  /**
   * Records a runner's call (presence) and judges it against the previous one (threat model C4, "Detection"): a
   * country the runner has never called from, or a second source address inside one lease window, marks the runner
   * suspect once — until the owner clears it (2-E) — and the caller audits the alert. One read, one write: a race
   * between two calls of the same runner costs at most a duplicate alert, never a missed one.
   */
  async sight(id: string, sighting: RunnerSighting, audit: (alert: RunnerSuspectReason) => NewAuditEvent): Promise<SightingOutcome> {
    const runner = await this.findById(id);
    if (runner === null) {
      return { alert: null, previousCountry: null };
    }
    const seenCountries =
      sighting.country !== null && !runner.seenCountries.includes(sighting.country)
        ? [...runner.seenCountries, sighting.country]
        : runner.seenCountries;
    const newCountry =
      sighting.country !== null && runner.seenCountries.length > 0 && !runner.seenCountries.includes(sighting.country);
    const withinWindow =
      runner.lastSeenAt !== null && Date.parse(sighting.at) - Date.parse(runner.lastSeenAt) <= TWO_POLLERS_WINDOW_MS;
    const twoPollers =
      sighting.ipHash !== null &&
      runner.lastSeenIpHash !== null &&
      runner.lastSeenIpHash !== sighting.ipHash &&
      withinWindow;
    const alert: RunnerSuspectReason | null =
      runner.suspectAt !== null ? null : twoPollers ? 'two-pollers' : newCountry ? 'new-country' : null;
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
