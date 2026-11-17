/**
 * The month's model spend per project (ADR 0009 d.6, migration 0032). #684 (PR 2) reconciles it at `finish` from the
 * CLI's `total_cost_usd` in the batch of the state transition; this repo reads it. The month is UTC `YYYY-MM`.
 */
export interface ProjectSpendRecord {
  readonly projectSlug: string;
  readonly month: string;
  readonly spentUsd: number;
  readonly jobs: number;
  /** "Resume this month" waived the month's budget (#684); `null` while it caps the month. */
  readonly waivedAt: string | null;
}

/** The UTC month `YYYY-MM` of an ISO instant. */
export function utcMonthOf(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('utcMonthOf needs an ISO instant');
  }
  return date.toISOString().slice(0, 7);
}

export class ProjectSpendRepo {
  constructor(private readonly db: D1Database) {}

  /** The project's spend in `month`; a month with no row spent nothing. */
  async findMonth(projectSlug: string, month: string): Promise<ProjectSpendRecord> {
    const row = await this.db
      .prepare(`SELECT spent_usd, jobs, waived_at FROM project_spend WHERE project_slug = ?1 AND month = ?2`)
      .bind(projectSlug, month)
      .first<{ spent_usd: number; jobs: number; waived_at: string | null }>();
    return {
      projectSlug,
      month,
      spentUsd: row?.spent_usd ?? 0,
      jobs: row?.jobs ?? 0,
      waivedAt: row?.waived_at ?? null,
    };
  }
}
