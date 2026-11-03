import { env } from 'cloudflare:test';
import { WebhookDeliveriesRepo, type WebhookDelivery } from './webhook-deliveries.repo';

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    deliveryId: 'd-1',
    event: 'issues',
    repo: 'geeera/team-console',
    bodySha256: 'a'.repeat(64),
    receivedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

async function count(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM webhook_deliveries').first<{ n: number }>();
  return row?.n ?? -1;
}

describe('WebhookDeliveriesRepo', () => {
  const deliveries = new WebhookDeliveriesRepo(env.DB);

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM webhook_deliveries').run();
  });

  it('records a new delivery with its row id', async () => {
    const result = await deliveries.record(delivery());
    expect(result).toEqual({ fresh: true, rowId: expect.any(Number) });
    expect(await count()).toBe(1);
  });

  it('refuses the same delivery id with another body', async () => {
    await deliveries.record(delivery());
    await expect(deliveries.record(delivery({ bodySha256: 'b'.repeat(64) }))).resolves.toEqual({
      fresh: false,
    });
    expect(await count()).toBe(1);
  });

  it('refuses the same body under a new delivery id (the id is not signed)', async () => {
    await deliveries.record(delivery());
    await expect(deliveries.record(delivery({ deliveryId: 'd-2' }))).resolves.toEqual({ fresh: false });
    expect(await count()).toBe(1);
  });

  it('forgets a delivery so that it can be recorded again', async () => {
    await deliveries.record(delivery());
    await deliveries.forget('d-1');
    await expect(deliveries.record(delivery())).resolves.toMatchObject({ fresh: true });
  });

  it('prunes only rows received before the cut-off', async () => {
    await deliveries.record(
      delivery({ deliveryId: 'old', bodySha256: '1'.repeat(64), receivedAt: '2026-09-20T00:00:00.000Z' }),
    );
    await deliveries.record(
      delivery({ deliveryId: 'new', bodySha256: '2'.repeat(64), receivedAt: '2026-09-30T00:00:00.000Z' }),
    );

    await expect(deliveries.pruneBefore('2026-09-24T00:00:00.000Z')).resolves.toBe(1);
    const { results } = await env.DB.prepare('SELECT delivery_id FROM webhook_deliveries').all<{
      delivery_id: string;
    }>();
    expect(results).toEqual([{ delivery_id: 'new' }]);
  });
});
