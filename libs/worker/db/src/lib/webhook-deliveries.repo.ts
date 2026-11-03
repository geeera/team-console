/** A verified webhook delivery as `webhook_deliveries` keeps it (migration 0010); the payload is never stored. */
export interface WebhookDelivery {
  readonly deliveryId: string;
  readonly event: string;
  /** `repository.full_name` as sent; `''` for installation-level events. */
  readonly repo: string;
  /** Hex SHA-256 of the raw body. */
  readonly bodySha256: string;
  /** ISO 8601 UTC. */
  readonly receivedAt: string;
}

/** What `record` decided: a new delivery (with its row id, for pruning on every n-th) or a replay. */
export type DeliveryRecord = { readonly fresh: true; readonly rowId: number } | { readonly fresh: false };

/** Delivery dedupe for the hooks Worker (#12). Every query is parameterised. */
export class WebhookDeliveriesRepo {
  constructor(private readonly db: D1Database) {}

  /**
   * Inserts the delivery unless its id **or** its body hash is already there — one statement, so two copies
   * arriving together cannot both pass.
   */
  async record(delivery: WebhookDelivery): Promise<DeliveryRecord> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, repo, body_sha256, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(delivery.deliveryId, delivery.event, delivery.repo, delivery.bodySha256, delivery.receivedAt)
      .run();
    return result.meta.changes === 1 ? { fresh: true, rowId: result.meta.last_row_id } : { fresh: false };
  }

  /** Drops a delivery whose processing failed, so GitHub's redelivery is processed instead of deduped. */
  async forget(deliveryId: string): Promise<void> {
    await this.db.prepare('DELETE FROM webhook_deliveries WHERE delivery_id = ?1').bind(deliveryId).run();
  }

  /** Deletes deliveries received before `before` (ISO 8601 UTC); the number of rows deleted. */
  async pruneBefore(before: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM webhook_deliveries WHERE received_at < ?1')
      .bind(before)
      .run();
    return result.meta.changes;
  }
}
