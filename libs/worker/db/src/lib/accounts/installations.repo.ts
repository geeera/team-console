import type { IdentityProvider } from '@shared/contracts';
import { isConstraintError } from '../tracker/constraint-error';
import { auditEventStatement } from './audit.repo';

/** One `installations` row (migration 0018): a provider installation linked to an account. */
export interface InstallationRecord {
  readonly id: number;
  readonly accountId: string;
  readonly provider: IdentityProvider;
  /** The provider's installation id, as text. */
  readonly installationId: string;
  readonly accountLogin: string;
  /** `null` only on rows migration 0018 backfilled without an owner user. */
  readonly linkedByUserId: string | null;
  readonly linkedAt: string;
  readonly suspendedAt: string | null;
}

interface InstallationRow {
  id: number;
  account_id: string;
  provider: IdentityProvider;
  installation_id: string;
  account_login: string;
  linked_by_user_id: string | null;
  linked_at: string;
  suspended_at: string | null;
}

const COLUMNS =
  'id, account_id, provider, installation_id, account_login, linked_by_user_id, linked_at, suspended_at';

function toRecord(row: InstallationRow): InstallationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    linkedByUserId: row.linked_by_user_id,
    linkedAt: row.linked_at,
    suspendedAt: row.suspended_at,
  };
}

/** A link to record (decision 4): the account is the admitted one, never a body member. */
export interface NewInstallationLink {
  readonly accountId: string;
  readonly provider: IdentityProvider;
  readonly installationId: string;
  readonly accountLogin: string;
  /** `null` while the Access owner has no linked user row (T-3 links it). */
  readonly linkedByUserId: string | null;
  readonly at: string;
}

/**
 * `linked`: the row and its audit event are written; `linked-elsewhere`: the installation is live under another
 * account, so nothing is written (one provider installation belongs to one account).
 */
export type LinkInstallationResult = 'linked' | 'already-linked' | 'linked-elsewhere';

/** Installation links (ADR 0008 decision 4). The setup-URL handshake arrives with T-4; the registry links here. */
export class InstallationsRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Links the installation to the account unless it is already linked (to this account: nothing to do; to another:
   * refused). The row and its `installation.linked` audit event land in one batch; a racing link of the same
   * installation trips the 0018 trigger or the live UNIQUE index and is read back as the winner's.
   */
  async link(link: NewInstallationLink): Promise<LinkInstallationResult> {
    const outcomeOf = (current: InstallationRecord | null): LinkInstallationResult | null =>
      current === null ? null : current.accountId === link.accountId ? 'already-linked' : 'linked-elsewhere';
    const before = outcomeOf(await this.findLinked(link.provider, link.installationId));
    if (before !== null) {
      return before;
    }
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_by_user_id, linked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(
            link.accountId,
            link.provider,
            link.installationId,
            link.accountLogin,
            link.linkedByUserId,
            link.at,
          ),
        auditEventStatement(this.db, {
          accountId: link.accountId,
          at: link.at,
          actorKind: link.linkedByUserId === null ? 'system' : 'user',
          actor: link.linkedByUserId ?? 'registry',
          kind: 'installation.linked',
          target: `${link.provider}:${link.installationId}`,
          details: { accountLogin: link.accountLogin },
        }),
      ]);
      return 'linked';
    } catch (error: unknown) {
      if (
        !isConstraintError(error, 'an installation link is never re-pointed') &&
        !isConstraintError(
          error,
          'UNIQUE constraint failed: installations.provider, installations.installation_id',
        )
      ) {
        throw error;
      }
      const after = outcomeOf(await this.findLinked(link.provider, link.installationId));
      if (after === null) {
        throw error;
      }
      return after;
    }
  }

  /**
   * The current link of a provider installation, which names the account a webhook delivery of it may reach
   * (decision 2's invariant, applied by T-2). Unlinked rows never answer.
   */
  async findLinked(provider: IdentityProvider, installationId: string): Promise<InstallationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM installations
         WHERE provider = ?1 AND installation_id = ?2 AND unlinked_at IS NULL`,
      )
      .bind(provider, installationId)
      .first<InstallationRow>();
    return row === null ? null : toRecord(row);
  }

  /** The account's linked installations, oldest first. */
  async listLinked(accountId: string): Promise<InstallationRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM installations WHERE account_id = ?1 AND unlinked_at IS NULL ORDER BY linked_at, id`,
      )
      .bind(accountId)
      .all<InstallationRow>();
    return results.map(toRecord);
  }
}
