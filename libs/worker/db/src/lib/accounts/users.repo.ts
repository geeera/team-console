import type { IdentityProvider } from '@shared/contracts';

/** One `users` row (migration 0018). The provider's id is the identity; `login` is display only. */
export interface UserRecord {
  readonly id: string;
  readonly provider: IdentityProvider;
  readonly providerUserId: string;
  readonly login: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  /** The linked Access identity (decision 3), written once by the explicit link. */
  readonly accessSubject: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

interface UserRow {
  id: string;
  provider: IdentityProvider;
  provider_user_id: string;
  login: string;
  email: string | null;
  avatar_url: string | null;
  access_subject: string | null;
  created_at: string;
  last_seen_at: string;
}

const COLUMNS =
  'id, provider, provider_user_id, login, email, avatar_url, access_subject, created_at, last_seen_at';

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    login: row.login,
    email: row.email,
    avatarUrl: row.avatar_url,
    accessSubject: row.access_subject,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Console users (ADR 0008 decision 3). Sign-in writes arrive with T-3; T-1 only reads. */
export class UsersRepo {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?1`).bind(id).first<UserRow>();
    return row === null ? null : toRecord(row);
  }

  /** By the provider's numeric id, never by login: a renamed login cannot land on another user. */
  async findByProviderId(provider: IdentityProvider, providerUserId: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM users WHERE provider = ?1 AND provider_user_id = ?2`)
      .bind(provider, providerUserId)
      .first<UserRow>();
    return row === null ? null : toRecord(row);
  }

  /** The user an Access identity was explicitly linked to; `null` when it was never linked. */
  async findByAccessSubject(accessSubject: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM users WHERE access_subject = ?1`)
      .bind(accessSubject)
      .first<UserRow>();
    return row === null ? null : toRecord(row);
  }
}
