import { env } from 'cloudflare:test';
import { RATE_WINDOW_MAX_SECONDS, RateLimitsRepo, rateWindowOf, retryAfterOf } from './rate-limits.repo';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');

describe('RateLimitsRepo', () => {
  const repo = new RateLimitsRepo(env.DB);

  it('counts hits inside a window and starts over in the next', async () => {
    expect(await repo.hit('k1', 'w1', 2)).toEqual({ allowed: true, count: 1 });
    expect(await repo.hit('k1', 'w1', 2)).toEqual({ allowed: true, count: 2 });
    expect(await repo.hit('k1', 'w1', 2)).toEqual({ allowed: false, count: 3 });
    expect(await repo.hit('k1', 'w2', 2)).toEqual({ allowed: true, count: 1 });
    expect(await repo.hit('k2', 'w2', 2)).toEqual({ allowed: true, count: 1 });
  });

  it('sweeps the rows of windows that started longer ago than the longest window (#489 review)', async () => {
    const old = rateWindowOf(T0, 60);
    await repo.hit('old-address', old, 5);
    await repo.hit('other-old', old, 5);
    expect(await repo.hit('fresh', rateWindowOf(T0 + (RATE_WINDOW_MAX_SECONDS + 60) * 1000, 60), 5)).toEqual({
      allowed: true,
      count: 1,
    });
    const { results } = await env.DB.prepare(
      `SELECT key FROM rate_limits WHERE key IN ('old-address', 'other-old', 'fresh')`,
    ).all<{ key: string }>();
    expect(results.map((row) => row.key)).toEqual(['fresh']);
  });

  // #537: a runner's minute counter is hit on every proxied job call; its sweep must not reset a job's 10-minute one.
  it('keeps a longer window counting while shorter windows are hit and swept', async () => {
    expect(await repo.hit('job:j1:sprint', rateWindowOf(T0, 600), 2)).toMatchObject({ count: 1 });
    await repo.hit('runner:r1', rateWindowOf(T0 + 300_000, 60), 120);
    await repo.hit('runner:r1', rateWindowOf(T0 + 540_000, 60), 120);
    expect(await repo.hit('job:j1:sprint', rateWindowOf(T0 + 599_000, 600), 2)).toMatchObject({ count: 2 });
    expect(await repo.hit('job:j1:sprint', rateWindowOf(T0 + 599_000, 600), 2)).toEqual({ allowed: false, count: 3 });
  });
});

describe('rateWindowOf', () => {
  it('labels a window by its start in epoch seconds, the same label for the whole window', () => {
    expect(rateWindowOf(T0, 60)).toBe(String(T0 / 1000));
    expect(rateWindowOf(T0 + 59_999, 60)).toBe(rateWindowOf(T0, 60));
    expect(rateWindowOf(T0 + 60_000, 60)).toBe(String(T0 / 1000 + 60));
    expect(rateWindowOf(T0 + 599_999, 600)).toBe(String(T0 / 1000));
    expect(rateWindowOf(T0 + 600_000, 600)).toBe(String(T0 / 1000 + 600));
  });

  it.each([0, -60, 1.5, RATE_WINDOW_MAX_SECONDS + 1])('refuses a window of %s seconds', (seconds) => {
    expect(() => rateWindowOf(T0, seconds)).toThrow(RangeError);
  });
});

describe('retryAfterOf', () => {
  it('is the whole window at its start, the rest mid-window and 1 in its last second', () => {
    expect(retryAfterOf(T0, 600)).toBe(600);
    expect(retryAfterOf(T0 + 250_400, 600)).toBe(350);
    expect(retryAfterOf(T0 + 599_999, 600)).toBe(1);
    expect(retryAfterOf(T0 + 600_000, 600)).toBe(600);
  });

  it('matches the minute counter’s seconds left to the next UTC minute', () => {
    const at = Date.parse('2026-11-10T10:03:17.250Z');
    expect(retryAfterOf(at, 60)).toBe(60 - new Date(at).getUTCSeconds());
  });
});
