/** Whether any event has arrived for a repository, and when the most recent one did (#83). */
export interface EventsSignal {
  readonly seen: boolean;
  /** ISO 8601 UTC of the most recent delivery; `null` while `seen` is `false`. */
  readonly lastEventAt: string | null;
}

/**
 * Signals about a project that other issues' migrations bring (#12: `webhook_deliveries`,
 * `projects.access_lost_at`). The registry ships before them, so each read feature-detects its table or column
 * and answers "nothing yet" instead of failing; once the migration lands the same code reads real data.
 */
export class ProjectSignalsRepo {
  constructor(private readonly db: D1Database) {}

  /** Any app webhook delivery for this repository, and the most recent one's time; `false`/`null` before the table exists. */
  async eventsFor(repo: string): Promise<EventsSignal> {
    const table = await this.db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'webhook_deliveries'")
      .first<{ found: number }>();
    if (table === null) {
      return { seen: false, lastEventAt: null };
    }
    const row = await this.db
      .prepare('SELECT max(received_at) AS lastEventAt FROM webhook_deliveries WHERE lower(repo) = lower(?1)')
      .bind(repo)
      .first<{ lastEventAt: string | null }>();
    const lastEventAt = row?.lastEventAt ?? null;
    return { seen: lastEventAt !== null, lastEventAt };
  }

  /** When the app lost access to the project's repository; `null` while the column does not exist. */
  async accessLostAt(slug: string): Promise<string | null> {
    const { results } = await this.db.prepare('PRAGMA table_info(projects)').all<{ name: string }>();
    if (!results.some((column) => column.name === 'access_lost_at')) {
      return null;
    }
    const row = await this.db
      .prepare('SELECT access_lost_at FROM projects WHERE slug = ?1')
      .bind(slug)
      .first<{ access_lost_at: string | null }>();
    return row?.access_lost_at ?? null;
  }
}
