import type { IdentityProvider } from '@shared/contracts';

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

/** Installation links (ADR 0008 decision 4). Linking and unlinking arrive with T-4; T-1 only reads. */
export class InstallationsRepo {
  constructor(private readonly db: D1Database) {}

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
