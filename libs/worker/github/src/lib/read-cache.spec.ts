import { MemoryReadCache, readCacheKey } from './read-cache';

const key = (slug: string, epoch = 0, type = 'repository', environment = 'dev') =>
  readCacheKey({ environment, slug, epoch, type });

function counter<T>(value: T) {
  const fill = vi.fn(async () => value);
  return fill;
}

describe('readCacheKey', () => {
  it('is env:slug:epoch:type', () => {
    expect(key('tc', 3, 'issues')).toBe('dev:tc:3:issues');
  });

  it.each([
    { environment: 'dev', slug: 'a:b', epoch: 0, type: 'x' },
    { environment: 'dev', slug: 'tc', epoch: 0, type: 'x:y' },
    { environment: 'DEV', slug: 'tc', epoch: 0, type: 'x' },
    { environment: 'dev', slug: 'tc', epoch: -1, type: 'x' },
    { environment: 'dev', slug: 'tc', epoch: 1.5, type: 'x' },
  ])('refuses parts that could collide: %o', (parts) => {
    expect(() => readCacheKey(parts)).toThrow();
  });
});

describe('MemoryReadCache', () => {
  it('fills once and serves the value for the TTL (60 s)', async () => {
    let now = 0;
    const cache = new MemoryReadCache({ now: () => now });
    const fill = counter('v1');

    await expect(cache.getOrFill(key('tc'), 60, fill)).resolves.toBe('v1');
    now = 59_999;
    await expect(cache.getOrFill(key('tc'), 60, fill)).resolves.toBe('v1');
    expect(fill).toHaveBeenCalledTimes(1);

    now = 60_000;
    await cache.getOrFill(key('tc'), 60, fill);
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it('keeps two slugs apart: two slugs → two fills (row 6)', async () => {
    const cache = new MemoryReadCache();
    await expect(cache.getOrFill(key('alpha'), 60, counter('a'))).resolves.toBe('a');
    await expect(cache.getOrFill(key('beta'), 60, counter('b'))).resolves.toBe('b');
    await expect(cache.getOrFill(key('alpha'), 60, counter('other'))).resolves.toBe('a');
  });

  it('keeps environments apart and refills after an epoch bump', async () => {
    const cache = new MemoryReadCache();
    await cache.getOrFill(key('tc', 0, 'repository', 'dev'), 60, counter('dev'));
    await expect(cache.getOrFill(key('tc', 0, 'repository', 'stage'), 60, counter('stage'))).resolves.toBe(
      'stage',
    );
    await expect(cache.getOrFill(key('tc', 1, 'repository', 'dev'), 60, counter('bumped'))).resolves.toBe(
      'bumped',
    );
  });

  it('evicts the least recently used entry over the cap (row 6)', async () => {
    const cache = new MemoryReadCache({ maxEntries: 2 });
    await cache.getOrFill(key('a'), 60, counter('a'));
    await cache.getOrFill(key('b'), 60, counter('b'));
    await cache.getOrFill(key('a'), 60, counter('a-again'));
    await cache.getOrFill(key('c'), 60, counter('c'));

    expect(cache.size).toBe(2);
    // `a` was read after `b`, so `b` is the one that went.
    const keepA = counter('a3');
    await expect(cache.getOrFill(key('a'), 60, keepA)).resolves.toBe('a');
    expect(keepA).not.toHaveBeenCalled();
    const refillB = counter('b2');
    await expect(cache.getOrFill(key('b'), 60, refillB)).resolves.toBe('b2');
    expect(refillB).toHaveBeenCalledTimes(1);
  });

  it('defaults to a cap of 200 entries', async () => {
    const cache = new MemoryReadCache();
    for (let index = 0; index < 205; index += 1) {
      await cache.getOrFill(key(`p${index}`), 60, counter(index));
    }
    expect(cache.size).toBe(200);
  });

  it('does not cache a failed fill', async () => {
    const cache = new MemoryReadCache();
    await expect(
      cache.getOrFill(key('tc'), 60, async () => {
        throw new Error('GitHub down');
      }),
    ).rejects.toThrow('GitHub down');
    await expect(cache.getOrFill(key('tc'), 60, counter('ok'))).resolves.toBe('ok');
  });

  it('shares one fill between concurrent misses', async () => {
    const cache = new MemoryReadCache();
    const fill = counter('shared');
    const values = await Promise.all([1, 2, 3].map(async () => cache.getOrFill(key('tc'), 60, fill)));
    expect(values).toEqual(['shared', 'shared', 'shared']);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('refuses a cap below one', () => {
    expect(() => new MemoryReadCache({ maxEntries: 0 })).toThrow();
  });
});
