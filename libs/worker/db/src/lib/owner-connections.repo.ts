/** One row of `owner_connections` (migration 0005); column names as in SQL. Token columns are ciphertext only. */
export interface OwnerConnectionRow {
  readonly environment: string;
  readonly login: string;
  readonly user_id: number;
  readonly access_token_enc: string;
  readonly refresh_token_enc: string;
  /** Epoch seconds. */
  readonly access_expires_at: number;
  /** Epoch seconds. */
  readonly refresh_expires_at: number;
  readonly key_id: string;
  readonly version: number;
  /** Epoch seconds; `null` when no refresh lease is held. */
  readonly refreshing_until: number | null;
  readonly connected_at: string;
  readonly updated_at: string;
}

/** A freshly encrypted token pair and its expiries (epoch seconds). */
export interface SealedTokenPair {
  readonly accessTokenEnc: string;
  readonly refreshTokenEnc: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly keyId: string;
}

export interface NewOwnerConnection extends SealedTokenPair {
  readonly environment: string;
  readonly login: string;
  readonly userId: number;
  /** ISO 8601 UTC. */
  readonly now: string;
}

const COLUMNS =
  'environment, login, user_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, ' +
  'key_id, version, refreshing_until, connected_at, updated_at';

/**
 * The owner connection of each environment (ADR 0003 decision 4). Every write that follows a read is guarded by
 * `version`, so a writer that lost a race changes nothing; the refresh lease is taken in one conditional UPDATE.
 */
export class OwnerConnectionsRepo {
  constructor(private readonly db: D1Database) {}

  async find(environment: string): Promise<OwnerConnectionRow | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM owner_connections WHERE environment = ?1`)
      .bind(environment)
      .first<OwnerConnectionRow>();
  }

  /** Stores a new connection, replacing any previous one of the environment; the version moves on. */
  async connect(connection: NewOwnerConnection): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO owner_connections (${COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, NULL, ?9, ?9)
         ON CONFLICT (environment) DO UPDATE SET
           login = excluded.login,
           user_id = excluded.user_id,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           key_id = excluded.key_id,
           version = owner_connections.version + 1,
           refreshing_until = NULL,
           connected_at = excluded.connected_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        connection.environment,
        connection.login,
        connection.userId,
        connection.accessTokenEnc,
        connection.refreshTokenEnc,
        connection.accessExpiresAt,
        connection.refreshExpiresAt,
        connection.keyId,
        connection.now,
      )
      .run();
  }

  /**
   * The single-flight refresh lease: true only for the one caller whose UPDATE matched — the row is still at
   * `version` and no unexpired lease is held.
   */
  async takeRefreshLease(
    environment: string,
    version: number,
    nowSeconds: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE owner_connections SET refreshing_until = ?3 + ?4
         WHERE environment = ?1 AND version = ?2 AND (refreshing_until IS NULL OR refreshing_until < ?3)`,
      )
      .bind(environment, version, nowSeconds, leaseSeconds)
      .run();
    return result.meta.changes === 1;
  }

  /** Writes a refreshed pair over `version`, bumps it and clears the lease; false when the row moved on. */
  async storeRefreshed(
    environment: string,
    version: number,
    pair: SealedTokenPair,
    now: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE owner_connections SET
           access_token_enc = ?3, refresh_token_enc = ?4, access_expires_at = ?5, refresh_expires_at = ?6,
           key_id = ?7, version = version + 1, refreshing_until = NULL, updated_at = ?8
         WHERE environment = ?1 AND version = ?2`,
      )
      .bind(
        environment,
        version,
        pair.accessTokenEnc,
        pair.refreshTokenEnc,
        pair.accessExpiresAt,
        pair.refreshExpiresAt,
        pair.keyId,
        now,
      )
      .run();
    return result.meta.changes === 1;
  }

  /** Deletes the row only while it is still at `version`: a newer pair written meanwhile survives. */
  async deleteAtVersion(environment: string, version: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM owner_connections WHERE environment = ?1 AND version = ?2')
      .bind(environment, version)
      .run();
    return result.meta.changes === 1;
  }

  /** Deletes the environment's connection whatever its version (after the grant was revoked at GitHub). */
  async delete(environment: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM owner_connections WHERE environment = ?1')
      .bind(environment)
      .run();
    return result.meta.changes === 1;
  }
}
