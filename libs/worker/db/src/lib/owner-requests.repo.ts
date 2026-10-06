export type OwnerRequestKind = 'sprint' | 'priority';
export type OwnerRequestResult = 'applied' | 'declined';

/** One request comment the console posted on the owner's token (`owner_requests`, migration 0012). */
export interface OwnerRequestRecord {
  readonly commentId: number;
  readonly slug: string;
  readonly issueNumber: number;
  readonly kind: OwnerRequestKind;
  /** The marker's canonical JSON. */
  readonly payload: string;
  readonly url: string;
  /** ISO 8601 UTC. */
  readonly requestedAt: string;
  readonly handledCommentId: number | null;
  readonly result: OwnerRequestResult | null;
  readonly handledAt: string | null;
}

export interface HandledMark {
  readonly slug: string;
  readonly issueNumber: number;
  /** The request comment the marker names. */
  readonly commentId: number;
  readonly handledCommentId: number;
  readonly result: OwnerRequestResult;
  /** ISO 8601: the handled comment's `created_at`. */
  readonly handledAt: string;
}

interface OwnerRequestRow {
  comment_id: number;
  slug: string;
  issue_number: number;
  kind: OwnerRequestKind;
  payload: string;
  url: string;
  requested_at: string;
  handled_comment_id: number | null;
  result: OwnerRequestResult | null;
  handled_at: string | null;
}

const COLUMNS =
  'comment_id, slug, issue_number, kind, payload, url, requested_at, handled_comment_id, result, handled_at';

// The newest row of its issue: no later request (ties broken by the larger comment id) exists.
const IS_NEWEST = `NOT EXISTS (
  SELECT 1 FROM owner_requests n
  WHERE n.slug = o.slug AND n.issue_number = o.issue_number
    AND (n.requested_at > o.requested_at OR (n.requested_at = o.requested_at AND n.comment_id > o.comment_id))
)`;

function toRecord(row: OwnerRequestRow): OwnerRequestRecord {
  return {
    commentId: row.comment_id,
    slug: row.slug,
    issueNumber: row.issue_number,
    kind: row.kind,
    payload: row.payload,
    url: row.url,
    requestedAt: row.requested_at,
    handledCommentId: row.handled_comment_id,
    result: row.result,
    handledAt: row.handled_at,
  };
}

/**
 * Owner requests to the PM (#219, ADR 0005 decision 3): a cache of GitHub comments that colours a board row and
 * prefills the form. Nothing here may drive a GitHub write or an authorisation decision. The newest request per
 * issue replaces older ones; a handled marker may name any of them.
 */
export class OwnerRequestsRepo {
  constructor(private readonly db: D1Database) {}

  /** Records a posted request; a replay of the same comment changes nothing. */
  async record(
    request: Omit<OwnerRequestRecord, 'handledCommentId' | 'result' | 'handledAt'>,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO owner_requests (comment_id, slug, issue_number, kind, payload, url, requested_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (comment_id) DO NOTHING`,
      )
      .bind(
        request.commentId,
        request.slug,
        request.issueNumber,
        request.kind,
        request.payload,
        request.url,
        request.requestedAt,
      )
      .run();
  }

  /** The issue's newest request, or `null`. */
  async latestFor(slug: string, issueNumber: number): Promise<OwnerRequestRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM owner_requests WHERE slug = ?1 AND issue_number = ?2
         ORDER BY requested_at DESC, comment_id DESC LIMIT 1`,
      )
      .bind(slug, issueNumber)
      .first<OwnerRequestRow>();
    return row === null ? null : toRecord(row);
  }

  /** Every request of the issue, oldest first: the rows a handled marker on it may name. */
  async allFor(slug: string, issueNumber: number): Promise<OwnerRequestRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM owner_requests WHERE slug = ?1 AND issue_number = ?2
         ORDER BY requested_at, comment_id`,
      )
      .bind(slug, issueNumber)
      .all<OwnerRequestRow>();
    return results.map(toRecord);
  }

  /** The newest request of every issue of the project, in one query (the board, the picker). */
  async latestPerIssue(slug: string): Promise<Map<number, OwnerRequestRecord>> {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM owner_requests o WHERE o.slug = ?1 AND ${IS_NEWEST}`)
      .bind(slug)
      .all<OwnerRequestRow>();
    return new Map(results.map((row) => [row.issue_number, toRecord(row)]));
  }

  /** Issues whose newest request still waits for the PM. */
  async countPending(slug: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS pending FROM owner_requests o WHERE o.slug = ?1 AND o.result IS NULL AND ${IS_NEWEST}`,
      )
      .bind(slug)
      .first<{ pending: number }>();
    return row?.pending ?? 0;
  }

  /**
   * Marks the named request handled, only when it is a request of the same project and issue and the marker came
   * after it; the latest marker wins. The caller has checked the marker's author and text. Returns whether a row
   * changed.
   */
  async markHandled(mark: HandledMark): Promise<boolean> {
    const handledMs = Date.parse(mark.handledAt);
    if (!Number.isFinite(handledMs)) {
      return false;
    }
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM owner_requests WHERE comment_id = ?1 AND slug = ?2 AND issue_number = ?3`,
      )
      .bind(mark.commentId, mark.slug, mark.issueNumber)
      .first<OwnerRequestRow>();
    if (row === null || !(handledMs > Date.parse(row.requested_at))) {
      return false;
    }
    if (row.handled_at !== null && Date.parse(row.handled_at) >= handledMs) {
      return false;
    }
    const handledAt = new Date(handledMs).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE owner_requests SET handled_comment_id = ?2, result = ?3, handled_at = ?4
         WHERE comment_id = ?1 AND (handled_at IS NULL OR handled_at < ?4)`,
      )
      .bind(mark.commentId, mark.handledCommentId, mark.result, handledAt)
      .run();
    return result.meta.changes === 1;
  }
}
