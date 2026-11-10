import { redactSecrets } from '@shared/redaction';
import { redact } from '@worker/core';
import {
  AUDIT_DETAILS_MAX_BYTES,
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
  constructor(bytes: number) {
    super(`audit details are ${bytes} bytes, more than ${AUDIT_DETAILS_MAX_BYTES}`);
    this.name = 'AuditDetailsTooLargeError';
  }
}

const COUNTRY = /^[A-Z]{2}$/;
const REDACTED = '[redacted]';
/**
 * Keys whose values are credentials whatever they look like. The value patterns know prefixed formats only (`ghs_`,
 * `tcj_`, `sk-ant-`, JWTs, PEM), but invite tokens and session ids are bare random strings, and an append-only row
 * can never be cleaned later. Over-matching (`errorCode`) costs a display value, never a secret.
 */
const SECRET_KEY = /token|secret|password|passphrase|credential|cookie|session|code|key$/i;
/** As deep as `redact` goes; deeper values are cut by it anyway. */
const MAX_DEPTH = 6;

/**
 * `details` holds ids and enums (#474 security re-check): a string is masked by the one pattern list the API, the
 * logger and the runner share (`@shared/redaction`, strict here and loose again inside `redact`), because an
 * append-only row can never be scrubbed.
 */
function withoutSecretKeys(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withoutSecretKeys(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : withoutSecretKeys(field, depth + 1),
    ]),
  );
}

/**
 * The redacted, bounded JSON of `details`: a credential that slipped into it, by key or by format, never lands in D1.
 * The bound is UTF-8 bytes, as the column's CHECK counts them.
 */
export function auditDetailsJson(details: Readonly<Record<string, unknown>> | undefined): string {
  const json = JSON.stringify(redact(withoutSecretKeys(details ?? {}, 0)));
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > AUDIT_DETAILS_MAX_BYTES) {
    throw new AuditDetailsTooLargeError(bytes);
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
