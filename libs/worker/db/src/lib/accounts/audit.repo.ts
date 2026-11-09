import { redact } from '@worker/core';
import {
  AUDIT_DETAILS_MAX_LENGTH,
  AUDIT_PAGE_MAX,
  type AuditActorKind,
  type AuditEventKind,
} from '@shared/contracts';

/** One audit row to write (ADR 0008 decision 5). Who acted is derived by the server, never taken from a body. */
export interface NewAuditEvent {
  /** `null` only for operator and system events outside an account (the table CHECKs it). */
  readonly accountId: string | null;
  readonly at: string;
  readonly actorKind: AuditActorKind;
  readonly actor: string;
  readonly kind: AuditEventKind;
  readonly target: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
  /** ISO 3166-1 alpha-2 from `CF-IPCountry`, when there is one. */
  readonly ipCountry?: string | null;
}

export interface AuditEventRecord {
  readonly id: number;
  readonly accountId: string | null;
  readonly at: string;
  readonly actorKind: AuditActorKind;
  readonly actor: string;
  readonly kind: AuditEventKind;
  readonly target: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly ipCountry: string | null;
}

export interface AuditPage {
  readonly events: readonly AuditEventRecord[];
  /** Pass as `before` for the next (older) page; `null` at the end. */
  readonly nextCursor: number | null;
}

interface AuditEventRow {
  id: number;
  account_id: string | null;
  at: string;
  actor_kind: AuditActorKind;
  actor: string;
  kind: AuditEventKind;
  target: string | null;
  details: string;
  ip_country: string | null;
}

/** Thrown for details that stay over the column's bound after redaction: a caller bug, never truncated silently. */
export class AuditDetailsTooLargeError extends Error {
  constructor(length: number) {
    super(`audit details are ${length} characters, more than ${AUDIT_DETAILS_MAX_LENGTH}`);
    this.name = 'AuditDetailsTooLargeError';
  }
}

const COUNTRY = /^[A-Z]{2}$/;

/** The redacted, bounded JSON of `details`: a credential that slipped into it never lands in D1. */
export function auditDetailsJson(details: Readonly<Record<string, unknown>> | undefined): string {
  const json = JSON.stringify(redact(details ?? {}));
  if (json.length > AUDIT_DETAILS_MAX_LENGTH) {
    throw new AuditDetailsTooLargeError(json.length);
  }
  return json;
}

/**
 * The audit row of an action, for the action's own batch, so both land in one transaction or neither does. There is
 * deliberately no update or delete statement for `audit_events` anywhere in @worker/db (tested); triggers refuse both.
 */
export function auditEventStatement(db: D1Database, event: NewAuditEvent): D1PreparedStatement {
  const ipCountry =
    event.ipCountry !== undefined && event.ipCountry !== null && COUNTRY.test(event.ipCountry)
      ? event.ipCountry
      : null;
  return db
    .prepare(
      `INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details, ip_country)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      event.accountId,
      event.at,
      event.actorKind,
      event.actor,
      event.kind,
      event.target,
      auditDetailsJson(event.details),
      ipCountry,
    );
}

function toRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    at: row.at,
    actorKind: row.actor_kind,
    actor: row.actor,
    kind: row.kind,
    target: row.target,
    // The column is CHECKed as a JSON object, so a parse failure is a broken database, not input.
    details: JSON.parse(row.details) as Record<string, unknown>,
    ipCountry: row.ip_country,
  };
}

/** The account audit (`audit_events`): append and read, nothing else. */
export class AuditRepo {
  constructor(private readonly db: D1Database) {}

  /** A standalone audit row; an action with its own writes uses `auditEventStatement` in its batch instead. */
  async append(event: NewAuditEvent): Promise<void> {
    await auditEventStatement(this.db, event).run();
  }

  /** Newest first, older than the event id `before` (`null`: from the newest), at most `limit` (1–100). */
  async listForAccount(accountId: string, before: number | null, limit: number): Promise<AuditPage> {
    const size = Math.min(Math.max(Math.trunc(limit), 1), AUDIT_PAGE_MAX);
    const { results } = await this.db
      .prepare(
        `SELECT id, account_id, at, actor_kind, actor, kind, target, details, ip_country FROM audit_events
         WHERE account_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3`,
      )
      .bind(accountId, before, size + 1)
      .all<AuditEventRow>();
    const page = results.slice(0, size).map(toRecord);
    const last = page.at(-1);
    return { events: page, nextCursor: results.length > size && last !== undefined ? last.id : null };
  }
}
