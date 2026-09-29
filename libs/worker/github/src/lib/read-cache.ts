/**
 * Short-lived cache of GitHub reads (ADR 0001 decisions 5/22 as corrected by the #9 architect note; the
 * amendment itself is ADR 0004). Not the Workers Cache API: "For Workers fronted by Cloudflare Access, the
 * Cache API is not currently available" (developers.cloudflare.com/workers/runtime-apis/cache/), and the api
 * Worker is fronted by Access on workers.dev. Behind an interface so a D1-backed cache can replace it.
 */

/** `env:slug:epoch:type`; only `readCacheKey` builds one. */
export type ReadCacheKey = string & { readonly [readCacheKeyBrand]: true };

declare const readCacheKeyBrand: unique symbol;

export interface ReadCacheKeyParts {
  /** `ENVIRONMENT`: one isolate never serves another environment's data, but the key says so anyway. */
  readonly environment: string;
  readonly slug: string;
  /** `projects.cache_epoch`: bumping it (webhooks, #12; own writes) invalidates every read of the project. */
  readonly epoch: number;
  /** What was read, e.g. `repository`, `issues`. */
  readonly type: string;
}

const KEY_PART = /^[a-z0-9-]+$/;

export function readCacheKey(parts: ReadCacheKeyParts): ReadCacheKey {
  for (const part of [parts.environment, parts.slug, parts.type]) {
    if (!KEY_PART.test(part)) {
      // A `:` inside a part could make two different reads share one key (#9 threat row 6).
      throw new Error('read cache key parts must match [a-z0-9-]+');
    }
  }
  if (!Number.isSafeInteger(parts.epoch) || parts.epoch < 0) {
    throw new Error('read cache epoch must be a non-negative integer');
  }
  return `${parts.environment}:${parts.slug}:${parts.epoch}:${parts.type}` as ReadCacheKey;
}

export interface ReadCache {
  /**
   * The cached value while it is younger than `ttlSeconds`, else `fill()`'s result, which is then cached.
   * A failed fill is not cached. Values are shared between requests and must not be mutated.
   */
  getOrFill<T>(key: ReadCacheKey, ttlSeconds: number, fill: () => Promise<T>): Promise<T>;
}

export interface MemoryReadCacheOptions {
  /** LRU cap so one isolate cannot grow without bound (row 6). */
  readonly maxEntries?: number;
  /** Milliseconds since the epoch; a seam for TTL tests. */
  readonly now?: () => number;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** Per-isolate LRU with TTL; concurrent misses on one key share one fill. */
export class MemoryReadCache implements ReadCache {
  private readonly entries = new Map<string, Entry>();
  private readonly filling = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryReadCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.now = options.now ?? (() => Date.now());
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async getOrFill<T>(key: ReadCacheKey, ttlSeconds: number, fill: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) {
      // Re-insert: Map keeps insertion order, so the first key is always the least recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as T;
    }
    this.entries.delete(key);

    const pending = this.filling.get(key);
    if (pending !== undefined) {
      return (await pending) as T;
    }
    const filled = fill();
    this.filling.set(key, filled);
    try {
      const value = await filled;
      this.store(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
      return value;
    } finally {
      this.filling.delete(key);
    }
  }

  private store(key: string, entry: Entry): void {
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
