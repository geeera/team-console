/**
 * The operator's stops (#759 PR 4, SEC 4; migration 0040): a row switches a write path off on the next request,
 * without a deploy. Read-only here on purpose: the operator writes a row with `wrangler d1 execute`, and no Worker
 * code inserts, updates or deletes one (`tools/workspace-checks/src/actions-setup-kill-switch.spec.ts`), so nothing a request can reach lifts a stop.
 */
export const OPERATOR_STOPS = ['actions-setup-write'] as const;
export type OperatorStop = (typeof OPERATOR_STOPS)[number];

export class OperatorStopsRepo {
  constructor(private readonly db: D1Database) {}

  /** Whether the operator has stopped `name`. A failed read throws: the caller never treats that as "not stopped". */
  async isStopped(name: OperatorStop): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS stopped FROM operator_stops WHERE name = ?1`)
      .bind(name)
      .first<{ stopped: number }>();
    return row !== null;
  }
}
