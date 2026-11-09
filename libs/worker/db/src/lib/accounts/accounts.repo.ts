import { isReservedSlug, isUlid, isValidSlug, type AccountPlan, type MemberRole } from '@shared/contracts';
import { isConstraintError } from '../tracker/constraint-error';
import { auditEventStatement } from './audit.repo';

/** One `accounts` row (migration 0018). `entitlements` is the operator's parsed override; read it via `entitlementsOf`. */
export interface AccountRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly plan: AccountPlan;
  readonly entitlements: unknown;
  readonly createdAt: string;
  readonly suspendedAt: string | null;
}

export interface Membership {
  readonly accountId: string;
  readonly role: MemberRole;
}

export interface MemberRecord {
  readonly userId: string;
  readonly login: string;
  readonly avatarUrl: string | null;
  readonly role: MemberRole;
  readonly joinedAt: string;
}

/** A self-service account (decision 1, T-3): its creator becomes its first owner in the same batch. */
export interface NewAccount {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly at: string;
}

export type CreateAccountResult = 'created' | 'slug-invalid' | 'slug-reserved' | 'slug-taken';

interface AccountRow {
  id: string;
  slug: string;
  name: string;
  plan: AccountPlan;
  entitlements: string;
  created_at: string;
  suspended_at: string | null;
}

const COLUMNS = 'id, slug, name, plan, entitlements, created_at, suspended_at';

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan,
    // CHECKed as a JSON object; `entitlementsOf` guards the content and fails closed.
    entitlements: JSON.parse(row.entitlements) as unknown,
    createdAt: row.created_at,
    suspendedAt: row.suspended_at,
  };
}

/** Accounts and their memberships (ADR 0008 decisions 1 and 3). Every query is parameterised. */
export class AccountsRepo {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?1`)
      .bind(id)
      .first<AccountRow>();
    return row === null ? null : toRecord(row);
  }

  async findBySlug(slug: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM accounts WHERE slug = ?1`)
      .bind(slug)
      .first<AccountRow>();
    return row === null ? null : toRecord(row);
  }

  /**
   * The account, its owner membership and the `account.created` audit row in one batch: all or nothing. A reserved
   * or malformed slug is refused before any write; a taken one by the UNIQUE constraint, so two concurrent creates
   * cannot both win.
   */
  async create(account: NewAccount): Promise<CreateAccountResult> {
    if (!isValidSlug(account.slug)) {
      return 'slug-invalid';
    }
    if (isReservedSlug(account.slug)) {
      return 'slug-reserved';
    }
    if (!isUlid(account.id)) {
      throw new Error('account ids are ULIDs');
    }
    try {
      await this.db.batch([
        this.db
          .prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, ?2, ?3, ?4)`)
          .bind(account.id, account.slug, account.name, account.at),
        this.db
          .prepare(
            `INSERT INTO account_members (account_id, user_id, role, invited_by, joined_at)
             VALUES (?1, ?2, 'owner', NULL, ?3)`,
          )
          .bind(account.id, account.ownerUserId, account.at),
        auditEventStatement(this.db, {
          accountId: account.id,
          at: account.at,
          actorKind: 'user',
          actor: account.ownerUserId,
          kind: 'account.created',
          target: account.slug,
        }),
      ]);
      return 'created';
    } catch (error: unknown) {
      if (isConstraintError(error, 'UNIQUE constraint failed: accounts.slug')) {
        return 'slug-taken';
      }
      throw error;
    }
  }

  /** Every account the user belongs to, read per request (memberships are never cached in a cookie, C9). */
  async membershipsOf(userId: string): Promise<Membership[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.account_id, m.role FROM account_members m JOIN accounts a ON a.id = m.account_id
         WHERE m.user_id = ?1 ORDER BY m.joined_at, m.account_id`,
      )
      .bind(userId)
      .all<{ account_id: string; role: MemberRole }>();
    return results.map((row) => ({ accountId: row.account_id, role: row.role }));
  }

  /** The user's role in the account, or `null` when they are not a member. */
  async roleOf(accountId: string, userId: string): Promise<MemberRole | null> {
    const role = await this.db
      .prepare('SELECT role FROM account_members WHERE account_id = ?1 AND user_id = ?2')
      .bind(accountId, userId)
      .first<MemberRole>('role');
    return role ?? null;
  }

  /** Owners first, then by join date. */
  async membersOf(accountId: string): Promise<MemberRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.user_id, u.login, u.avatar_url, m.role, m.joined_at
         FROM account_members m JOIN users u ON u.id = m.user_id
         WHERE m.account_id = ?1 ORDER BY m.role = 'owner' DESC, m.joined_at, m.user_id`,
      )
      .bind(accountId)
      .all<{
        user_id: string;
        login: string;
        avatar_url: string | null;
        role: MemberRole;
        joined_at: string;
      }>();
    return results.map((row) => ({
      userId: row.user_id,
      login: row.login,
      avatarUrl: row.avatar_url,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }
}
