import {
  isAccessSource,
  type EnrolmentIsolation,
  type RunnerCapabilitiesDto,
  type RunnerHostDto,
  type RunnerProjectScope,
} from '@shared/contracts';
import { auditedWrite, type NewAuditEvent } from '../accounts/audit.repo';
import { isConstraintError } from '../tracker/constraint-error';
import { runnerInsertStatement, type NewRunner } from './runners.repo';

/**
 * Enrolment intents (#634 PR 3, migration 0037; threat model C4 R-INT-1…7). Every owner-side read and write names the
 * account **and** the creator, so an intent of another account or of another owner of the same account does not
 * exist for the caller (R-INT-2). The runner an approval creates is built from the row alone (R-INT-6) and written by
 * the same INSERT the one-time code uses. The audit row of a change travels in the change's own batch and is written
 * only when the change took effect.
 *
 * One write happens outside this repo (#899, migration 0044): the Access–GitHub link withdraws the live intents the
 * owner made as `access-owner`, since the creator they name no longer matches the owner's actor.
 */

export type StoredIntentState = 'pending' | 'bound' | 'approved' | 'used' | 'withdrawn';

/** What a runner bound to the intent: all of it or none of it (the 0037 CHECKs). */
export interface EnrolmentIntentBind {
  /** The `x` of the runner's Ed25519 public JWK. */
  readonly publicKeyX: string;
  readonly host: RunnerHostDto;
  readonly capabilities: RunnerCapabilitiesDto;
  readonly version: string;
  readonly fingerprint: string;
  readonly pollTokenHash: string;
  readonly at: string;
  readonly country: string | null;
}

export interface EnrolmentIntentRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
  readonly isolation: EnrolmentIsolation;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** As stored; whether a pending or bound intent has expired is the reader's judgement against its own `now`. */
  readonly state: StoredIntentState;
  readonly bind: EnrolmentIntentBind | null;
  readonly approvedAt: string | null;
  readonly runnerId: string | null;
}

export interface NewEnrolmentIntent {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly projectScope: RunnerProjectScope;
  readonly allowedProjects: readonly string[];
  readonly isolation: EnrolmentIsolation;
  readonly createdBy: string;
  readonly at: string;
  readonly expiresAt: string;
}

/** The caps a creation is judged against inside its own INSERT (R-INT-5). */
export interface EnrolmentIntentCaps {
  readonly liveMax: number;
  readonly perHour: number;
}

export type CreateIntentOutcome = 'ok' | 'live-limit' | 'hourly-limit';

/** Who is asking, on the owner's side: the account and the audit actor that must have created the intent. */
export interface IntentOwner {
  readonly accountId: string;
  readonly createdBy: string;
}

interface IntentRow {
  id: string;
  account_id: string;
  name: string;
  project_scope: RunnerProjectScope;
  allowed_projects: string;
  isolation: EnrolmentIsolation;
  created_by: string;
  created_at: string;
  expires_at: string;
  state: StoredIntentState;
  public_key: string | null;
  host: string | null;
  capabilities: string | null;
  version: string | null;
  fingerprint: string | null;
  poll_token_hash: string | null;
  bound_at: string | null;
  bound_country: string | null;
  approved_at: string | null;
  runner_id: string | null;
}

const COLUMNS = `id, account_id, name, project_scope, allowed_projects, isolation, created_by, created_at, expires_at, state,
  public_key, host, capabilities, version, fingerprint, poll_token_hash, bound_at, bound_country, approved_at, runner_id`;

/** An intent that can still be bound or approved at the time bound to `now` (a numbered placeholder). */
const liveSql = (now: string): string => `state IN ('pending', 'bound') AND julianday(expires_at) > julianday(${now})`;
/** Rows this old are long final (an intent lives ten minutes) and outside every cap's window; the audit keeps them. */
const PRUNE_AFTER = '-1 day';

function bindOf(row: IntentRow): EnrolmentIntentBind | null {
  if (
    row.public_key === null ||
    row.host === null ||
    row.capabilities === null ||
    row.version === null ||
    row.fingerprint === null ||
    row.poll_token_hash === null ||
    row.bound_at === null
  ) {
    return null;
  }
  const host = JSON.parse(row.host) as Partial<RunnerHostDto>;
  const capabilities = JSON.parse(row.capabilities) as Partial<RunnerCapabilitiesDto>;
  const declared = capabilities.accessSources;
  return {
    publicKeyX: row.public_key,
    host: { os: host.os ?? '', arch: host.arch ?? '', hostname: host.hostname ?? '' },
    capabilities: {
      local: capabilities.local === true,
      maxConcurrency: capabilities.maxConcurrency ?? 1,
      ...(Array.isArray(declared) && declared.every(isAccessSource) ? { accessSources: declared } : {}),
    },
    version: row.version,
    fingerprint: row.fingerprint,
    pollTokenHash: row.poll_token_hash,
    at: row.bound_at,
    country: row.bound_country,
  };
}

function toRecord(row: IntentRow): EnrolmentIntentRecord {
  const list: unknown = JSON.parse(row.allowed_projects);
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    projectScope: row.project_scope,
    allowedProjects: Array.isArray(list) ? list.filter((slug): slug is string => typeof slug === 'string') : [],
    isolation: row.isolation,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state: row.state,
    bind: bindOf(row),
    approvedAt: row.approved_at,
    runnerId: row.runner_id,
  };
}

export class EnrolmentIntentsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * The intent and the audit row of its creation, in one batch. The caps are judged by the INSERT itself, so two
   * creations racing at the cap cannot both pass: `live-limit` while the account already holds `liveMax` intents that
   * can still be bound or approved, `hourly-limit` once it made `perHour` in the last hour. Nothing is written then.
   */
  async create(intent: NewEnrolmentIntent, caps: EnrolmentIntentCaps, audit: NewAuditEvent): Promise<CreateIntentOutcome> {
    const live = `SELECT COUNT(*) FROM runner_enrolment_requests WHERE account_id = ?2 AND ${liveSql('?8')}`;
    const lastHour = `SELECT COUNT(*) FROM runner_enrolment_requests
                      WHERE account_id = ?2 AND julianday(created_at) > julianday(?8, '-1 hour')`;
    const [, insert] = await this.db.batch([
      this.db
        .prepare(`DELETE FROM runner_enrolment_requests WHERE account_id = ?1 AND julianday(created_at) < julianday(?2, ?3)`)
        .bind(intent.accountId, intent.at, PRUNE_AFTER),
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `INSERT INTO runner_enrolment_requests (id, account_id, name, project_scope, allowed_projects, isolation, created_by, created_at, expires_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             WHERE (${live}) < ?10 AND (${lastHour}) < ?11`,
          )
          .bind(
            intent.id,
            intent.accountId,
            intent.name,
            intent.projectScope,
            JSON.stringify(intent.projectScope === 'all' ? [] : intent.allowedProjects),
            intent.isolation,
            intent.createdBy,
            intent.at,
            intent.expiresAt,
            caps.liveMax,
            caps.perHour,
          ),
        audit,
      ),
    ]);
    if ((insert?.meta.changes ?? 0) === 1) {
      return 'ok';
    }
    // The INSERT judged it; this read only names which cap held.
    const counts = await this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM runner_enrolment_requests WHERE account_id = ?1 AND ${liveSql('?2')}) AS live`,
      )
      .bind(intent.accountId, intent.at)
      .first<{ live: number }>();
    return (counts?.live ?? 0) >= caps.liveMax ? 'live-limit' : 'hourly-limit';
  }

  /** The runner door's read: by id alone, since the caller has no account yet. Never used on the owner's side. */
  async findById(id: string): Promise<EnrolmentIntentRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM runner_enrolment_requests WHERE id = ?1`)
      .bind(id)
      .first<IntentRow>();
    return row === null ? null : toRecord(row);
  }

  /** The owner's read: an intent of another account, or made by another owner, is `null` like one that never was. */
  async findOwned(owner: IntentOwner, id: string): Promise<EnrolmentIntentRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM runner_enrolment_requests WHERE id = ?1 AND account_id = ?2 AND created_by = ?3`)
      .bind(id, owner.accountId, owner.createdBy)
      .first<IntentRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * Binds a runner's key to a pending intent: first bind wins. `false` when the intent is no longer pending (another
   * `start` won, or the owner withdrew it), has expired at `bind.at`, was made for another backend than `isolation`,
   * or its account is suspended; nothing is written then, the audit row included. The UPDATE's own WHERE decides, and
   * the 0037 trigger refuses a second bind even past it.
   */
  async bind(id: string, isolation: EnrolmentIsolation, bind: EnrolmentIntentBind, audit: NewAuditEvent): Promise<boolean> {
    try {
      const [update] = await this.db.batch([
        ...auditedWrite(
          this.db,
          this.db
            .prepare(
              `UPDATE runner_enrolment_requests
               SET state = 'bound', public_key = ?2, host = ?3, capabilities = ?4, version = ?5, fingerprint = ?6,
                   poll_token_hash = ?7, bound_at = ?8, bound_country = ?9
               WHERE id = ?1 AND state = 'pending' AND isolation = ?10 AND julianday(expires_at) > julianday(?8)
                 AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = runner_enrolment_requests.account_id AND a.suspended_at IS NULL)`,
            )
            .bind(
              id,
              bind.publicKeyX,
              JSON.stringify(bind.host),
              JSON.stringify(bind.capabilities),
              bind.version,
              bind.fingerprint,
              bind.pollTokenHash,
              bind.at,
              bind.country,
              isolation,
            ),
          audit,
        ),
      ]);
      return (update?.meta.changes ?? 0) === 1;
    } catch (error: unknown) {
      if (isConstraintError(error, 'an enrolment request is bound once')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The owner withdraws (rejects) an intent that is still pending or bound. `false` when it is not the caller's, has
   * expired, or was already approved or withdrawn; the audit row is written only when this call withdrew it.
   */
  async withdraw(owner: IntentOwner, id: string, at: string, audit: NewAuditEvent): Promise<boolean> {
    const [update] = await this.db.batch([
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runner_enrolment_requests SET state = 'withdrawn', withdrawn_at = ?4
             WHERE id = ?1 AND account_id = ?2 AND created_by = ?3 AND ${liveSql('?4')}`,
          )
          .bind(id, owner.accountId, owner.createdBy, at),
        audit,
      ),
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }

  /**
   * The owner approves a bound intent: the runner row, the intent's approval and the `runner.enrolled` audit row in
   * one batch. The runner is built here from the stored row alone (R-INT-6) — account, name, scope, list, backend and
   * `enrolled_by` are the creator's, the key, host, capabilities and version the binder's — and `audit` describes that
   * row. `fingerprint` is what the owner was shown: the write holds only while the bound key still is that one
   * (compare-and-set), the intent is unexpired and its account not suspended. `null` when the write did not happen;
   * the caller re-reads to say why.
   */
  async approve(
    owner: IntentOwner,
    id: string,
    approval: { readonly fingerprint: string; readonly runnerId: string; readonly at: string },
    audit: (intent: EnrolmentIntentRecord, bind: EnrolmentIntentBind) => NewAuditEvent,
  ): Promise<EnrolmentIntentRecord | null> {
    const intent = await this.findOwned(owner, id);
    if (intent === null || intent.bind === null || intent.state !== 'bound') {
      return null;
    }
    const { bind } = intent;
    const runner: NewRunner = {
      id: approval.runnerId,
      accountId: intent.accountId,
      name: intent.name,
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: bind.publicKeyX },
      host: bind.host,
      capabilities: bind.capabilities,
      isolation: intent.isolation,
      projectScope: intent.projectScope,
      allowedProjects: intent.allowedProjects,
      // D3 (#775): the intent's creator is the enrolling owner; the scope term compares it with `projects.created_by`.
      enrolledBy: intent.createdBy,
      version: bind.version,
      at: approval.at,
    };
    // The key in the gate ties the row written to the row read: a bound key never changes (0037), so this holds
    // exactly while the intent is still the one the owner saw.
    const stillBound = `i.id = ? AND i.account_id = ?2 AND i.created_by = ? AND i.state = 'bound' AND i.fingerprint = ?
      AND i.public_key = ? AND julianday(i.expires_at) > julianday(?10)`;
    const [, update] = await this.db.batch([
      // Never hosted: an intent enrols a customer's own machine only.
      runnerInsertStatement(this.db, runner, false, {
        exists: `SELECT 1 FROM runner_enrolment_requests i JOIN accounts a ON a.id = i.account_id
                 WHERE ${stillBound} AND a.suspended_at IS NULL`,
        params: [id, owner.createdBy, approval.fingerprint, bind.publicKeyX],
      }),
      // Approved only once its runner row exists, so the two can never disagree; the audit row only with both.
      ...auditedWrite(
        this.db,
        this.db
          .prepare(
            `UPDATE runner_enrolment_requests SET state = 'approved', approved_at = ?2, approved_by = ?3, runner_id = ?4
             WHERE id = ?1 AND state = 'bound' AND EXISTS (SELECT 1 FROM runners WHERE id = ?4)`,
          )
          .bind(id, approval.at, owner.createdBy, approval.runnerId),
        audit(intent, bind),
      ),
    ]);
    return (update?.meta.changes ?? 0) === 1
      ? { ...intent, state: 'approved', approvedAt: approval.at, runnerId: approval.runnerId }
      : null;
  }

  /**
   * Admits one poll of the binder and records its time: `false` when the last admitted poll was less than
   * `minGapSeconds` ago (`slow-down`). Only a poll that proved the token reaches this, so a stranger who knows the
   * intent's id cannot slow the real runner down.
   */
  async admitPoll(id: string, pollTokenHash: string, at: string, minGapSeconds: number): Promise<boolean> {
    // Only this statement writes the column, always as `toISOString()`, so the two compare as text: exact at the
    // boundary, where a julianday difference is not.
    const lastAllowed = new Date(Date.parse(at) - minGapSeconds * 1000).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE runner_enrolment_requests SET last_polled_at = ?3
         WHERE id = ?1 AND poll_token_hash = ?2 AND (last_polled_at IS NULL OR last_polled_at <= ?4)`,
      )
      .bind(id, pollTokenHash, at, lastAllowed)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * The binder collects its enrolment, once: the approved intent becomes `used` and the runner's id comes back.
   * `null` when the intent is not approved, was collected already, the token is not its own, or the collection
   * window (`expires_at`, or `collectSeconds` after the approval, whichever is later) has passed.
   */
  async collect(id: string, pollTokenHash: string, at: string, collectSeconds: number): Promise<string | null> {
    const row = await this.db
      .prepare(
        `UPDATE runner_enrolment_requests SET state = 'used', collected_at = ?3
         WHERE id = ?1 AND poll_token_hash = ?2 AND state = 'approved'
           AND (julianday(expires_at) > julianday(?3) OR julianday(approved_at, ?4) > julianday(?3))
         RETURNING runner_id`,
      )
      .bind(id, pollTokenHash, at, `+${String(collectSeconds)} seconds`)
      .first<{ runner_id: string }>();
    return row?.runner_id ?? null;
  }
}
