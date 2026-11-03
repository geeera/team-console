export type OwnWriteKind = 'answer' | 'chat' | 'pause' | 'resume' | 'request';

/** A comment the console wrote with the owner's token (`own_writes`, migration 0007). */
export interface OwnWrite {
  readonly commentId: number;
  readonly repo: string;
  readonly issueNumber: number;
  readonly kind: OwnWriteKind;
  readonly bodyHash: string | null;
  readonly url: string;
  /** ISO 8601 UTC on the Worker's clock: the replay window compares it with that clock, never with GitHub's. */
  readonly createdAt: string;
}

interface OwnWriteRow {
  comment_id: number;
  repo: string;
  issue_number: number;
  kind: OwnWriteKind;
  body_hash: string | null;
  url: string;
  created_at: string;
}

function toOwnWrite(row: OwnWriteRow): OwnWrite {
  return {
    commentId: row.comment_id,
    repo: row.repo,
    issueNumber: row.issue_number,
    kind: row.kind,
    bodyHash: row.body_hash,
    url: row.url,
    createdAt: row.created_at,
  };
}

/**
 * The console's own writes (#10, #12). `record` after GitHub accepted a comment; `findRecentByHash` answers a
 * repeat of the same body; `claim`/`release` make sure two requests with the same body never post together.
 */
export class OwnWritesRepo {
  constructor(private readonly db: D1Database) {}

  async record(write: OwnWrite): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO own_writes (comment_id, repo, issue_number, kind, body_hash, url, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        write.commentId,
        write.repo,
        write.issueNumber,
        write.kind,
        write.bodyHash,
        write.url,
        write.createdAt,
      )
      .run();
  }

  /** The latest write of this body on this issue created after `since` (ISO 8601 UTC), or `null`. */
  async findRecentByHash(
    repo: string,
    issueNumber: number,
    bodyHash: string,
    since: string,
  ): Promise<OwnWrite | null> {
    const row = await this.db
      .prepare(
        `SELECT comment_id, repo, issue_number, kind, body_hash, url, created_at FROM own_writes
         WHERE repo = ?1 AND issue_number = ?2 AND created_at > ?3 AND body_hash = ?4
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(repo, issueNumber, since, bodyHash)
      .first<OwnWriteRow>();
    return row === null ? null : toOwnWrite(row);
  }

  /** Whether the console wrote this comment (#12's own-write filter); GitHub comment ids are global. */
  async isOwnComment(commentId: number): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS found FROM own_writes WHERE comment_id = ?1')
      .bind(commentId)
      .first<{ found: number }>();
    return row !== null;
  }

  /** Takes the in-flight claim on `bodyHash` unless another request holds one that has not expired. */
  async claim(bodyHash: string, nowMs: number, holdMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO own_write_claims (body_hash, expires_at) VALUES (?1, ?2)
         ON CONFLICT (body_hash) DO UPDATE SET expires_at = excluded.expires_at
         WHERE own_write_claims.expires_at <= ?3`,
      )
      .bind(bodyHash, nowMs + holdMs, nowMs)
      .run();
    return result.meta.changes === 1;
  }

  async release(bodyHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM own_write_claims WHERE body_hash = ?1').bind(bodyHash).run();
  }
}
