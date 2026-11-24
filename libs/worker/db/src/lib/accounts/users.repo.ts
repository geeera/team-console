import { DISPLAY_NAME_MAX, type IdentityProvider } from '@shared/contracts';

/** One `users` row (migration 0018). The provider's id is the identity; `login` is display only. */
export interface UserRecord {
  readonly id: string;
  readonly provider: IdentityProvider;
  readonly providerUserId: string;
  readonly login: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  /** The profile name (#775, migration 0038): display only, already cleaned at write; `null` when there is none. */
  readonly displayName: string | null;
  /**
   * The linked Access identity (decision 3), written once by the explicit link (0018 refuses a second write).
   *
   * The link has a side effect in the database (#838, migration 0042): writing `access_subject` (an UPDATE of a row, or
   * the INSERT of a row already linked) fires a trigger that, while exactly one user is linked, hands the owner account's
   * `runners.enrolled_by` and `projects.created_by` = `access-owner` to that user in the same statement, and writes the
   * one `auth.access-actor-adopted` audit row. The 0036 rule that an enroller is never changed has one exception for it
   * (`access-owner` -> the linked user). A future link route therefore writes the link first, in one statement, and must
   * not write its own `auth.access-actor-adopted` row or move those columns itself; with two linked users nothing moves.
   *
   * #899 (migration 0044): the hand-over needs the linked user to be a member of the owner account, and happens at
   * whichever of the link and that membership is written last. It also withdraws the live enrolment intents made as
   * `access-owner` (their `created_by` is never rewritten, so nobody could reach them after the link); the audit row
   * counts them as `intents`.
   */
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
  display_name: string | null;
  access_subject: string | null;
  created_at: string;
  last_seen_at: string;
}

const COLUMNS =
  'id, provider, provider_user_id, login, email, avatar_url, display_name, access_subject, created_at, last_seen_at';

/** Control, format (bidi overrides and isolates among them) and line/paragraph separators, as R-INT-7 refuses them. */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A provider's profile name as the console may show it (#775): those characters stripped, whitespace collapsed and
 * trimmed, cut to `DISPLAY_NAME_MAX` code points; `null` for anything that is not a string or is empty after.
 * The name is still plain text for interpolation only, never markup.
 */
export function displayNameOf(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const cleaned = raw.replace(UNSHOWN, '').replace(/\s+/gu, ' ').trim();
  const kept = [...cleaned].slice(0, DISPLAY_NAME_MAX).join('').trim();
  return kept === '' ? null : kept;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    login: row.login,
    email: row.email,
    avatarUrl: row.avatar_url,
    displayName: row.display_name,
    accessSubject: row.access_subject,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Console users (ADR 0008 decision 3). Sign-in writes arrive with T-3; until then the one write is the profile name
 * the owner's GitHub connect refreshes (#775).
 */
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

  /**
   * The user an Access identity was explicitly linked to; `null` when it was never linked. A read only: whatever the
   * link handed over (migration 0042, see `UserRecord.accessSubject`) is already that user's by the time this finds it.
   */
  async findByAccessSubject(accessSubject: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM users WHERE access_subject = ?1`)
      .bind(accessSubject)
      .first<UserRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * The profile name of the user the provider id names, cleaned by `displayNameOf`, written at sign-in and on every
   * later one (#775). Creates no user: a provider id with no row changes nothing. Whether a row changed.
   */
  async refreshDisplayName(provider: IdentityProvider, providerUserId: string, rawName: unknown): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE users SET display_name = ?3
         WHERE provider = ?1 AND provider_user_id = ?2 AND display_name IS NOT ?3`,
      )
      .bind(provider, providerUserId, displayNameOf(rawName))
      .run();
    return result.meta.changes > 0;
  }
}
