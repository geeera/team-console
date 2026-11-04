import { env } from 'cloudflare:test';
import { IdempotencyKeysRepo } from './idempotency-keys.repo';

const keys = (): IdempotencyKeysRepo => new IdempotencyKeysRepo(env.DB);
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const HOLD = 30_000;
const DAY = 24 * 60 * 60 * 1000;

async function complete(key: string, hash: string, ref: string, at = NOW): Promise<void> {
  await keys()
    .completeStatement(key, hash, { status: 201, kind: 'item', ref: { value: ref } }, at + DAY)
    .run();
}

describe('IdempotencyKeysRepo', () => {
  it('lets one request claim a key; a second one waits while it is in flight', async () => {
    expect(await keys().claim('k-1', 'h', NOW, HOLD)).toEqual({ state: 'claimed' });
    expect(await keys().claim('k-1', 'h', NOW + 1, HOLD)).toEqual({ state: 'in-flight' });
  });

  it('answers a completed key with its result, and refuses it for a different request', async () => {
    await keys().claim('k-2', 'h', NOW, HOLD);
    await complete('k-2', 'h', '12');
    expect(await keys().claim('k-2', 'h', NOW + 1000, HOLD)).toEqual({
      state: 'done',
      status: 201,
      kind: 'item',
      ref: '12',
    });
    expect(await keys().claim('k-2', 'other', NOW + 1000, HOLD)).toEqual({ state: 'mismatch' });
  });

  it('frees a released claim at once, but never a completed key', async () => {
    await keys().claim('k-3', 'h', NOW, HOLD);
    await keys().release('k-3', 'h');
    expect(await keys().claim('k-3', 'h2', NOW, HOLD)).toEqual({ state: 'claimed' });
    await complete('k-3', 'h2', '1');
    await keys().release('k-3', 'h2');
    expect(await keys().claim('k-3', 'h2', NOW, HOLD)).toMatchObject({ state: 'done' });
  });

  it('takes a key again once it expired: a claim after its hold, a result after 24 hours', async () => {
    await keys().claim('k-4', 'h', NOW, HOLD);
    expect(await keys().claim('k-4', 'h', NOW + HOLD, HOLD)).toEqual({ state: 'claimed' });
    await complete('k-4', 'h', '5');
    expect(await keys().claim('k-4', 'new', NOW + DAY - 1, HOLD)).toEqual({ state: 'mismatch' });
    expect(await keys().claim('k-4', 'new', NOW + DAY, HOLD)).toEqual({ state: 'claimed' });
  });

  it('prunes expired keys as it claims', async () => {
    await keys().claim('k-old', 'h', NOW, HOLD);
    await keys().claim('k-new', 'h', NOW + HOLD + 1, HOLD);
    await expect(
      env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = 'k-old'").first(),
    ).resolves.toBeNull();
  });
});
