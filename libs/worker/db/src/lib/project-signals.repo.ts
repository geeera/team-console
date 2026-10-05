/** Whether any event has arrived for a repository, and when the most recent one did (#83). */
export interface EventsSignal {
  readonly seen: boolean;
  /** ISO 8601 UTC of the most recent delivery; `null` while `seen` is `false`. */
  readonly lastEventAt: string | null;
}

/** Signals about a project that the hooks Worker records (#12, migration 0010), read by Settings (#83). */
export class ProjectSignalsRepo {
  constructor(private readonly db: D1Database) {}

  /** Any app webhook delivery for this repository (any case), and the most recent one's time. */
  async eventsFor(repo: string): Promise<EventsSignal> {
    const row = await this.db
      .prepare('SELECT max(received_at) AS lastEventAt FROM webhook_deliveries WHERE lower(repo) = lower(?1)')
      .bind(repo)
      .first<{ lastEventAt: string | null }>();
    const lastEventAt = row?.lastEventAt ?? null;
    return { seen: lastEventAt !== null, lastEventAt };
  }

  /** When the app lost access to the project's repository; `null` while it has access or for an unknown slug. */
  async accessLostAt(slug: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT access_lost_at FROM projects WHERE slug = ?1')
      .bind(slug)
      .first<{ access_lost_at: string | null }>();
    return row?.access_lost_at ?? null;
  }
}
