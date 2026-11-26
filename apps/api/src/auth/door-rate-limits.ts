import { rateLimitAddressOf, sha256Hex, type Logger } from '@worker/core';
import { RateLimitsRepo, rateWindowOf, retryAfterOf } from '@worker/db';

/** The doors that take a caller with no account credential yet: they count the same three ways. */
export type DoorScope = 'enrol' | 'oidc';

/** What a door was over, for its log line: the caller's address, junk across the environment, or verified traffic. */
export type DoorLimitScope = 'ip' | 'unverified' | 'verified';

const WINDOW_SECONDS = 60;

/**
 * The fixed-minute counters of an unauthenticated runner door (#696; #467's D1 counters). Three buckets, so a flood
 * never shares one with a real caller:
 * - per address, before anything is read: an IPv4 address, or an IPv6 /64 (one caller holds a whole /64);
 * - `unverified`, for the environment, hit only by a request refused before its credential held (malformed body,
 *   bad signature, unknown code): once over, junk is answered 429 instead of its refusal;
 * - `verified`, for the environment, hit only once the credential held: junk at any rate never reaches it.
 * Rows hold a hash of the address unit, never the address.
 */
export class DoorRateLimits {
  private readonly repo: RateLimitsRepo;
  private readonly window: string;

  constructor(
    db: D1Database,
    private readonly scope: DoorScope,
    private readonly now: number,
  ) {
    this.repo = new RateLimitsRepo(db);
    this.window = rateWindowOf(now, WINDOW_SECONDS);
  }

  /**
   * One hit for the caller's `CF-Connecting-IP`; a missing or malformed one counts in one shared `unknown` bucket.
   * `bucket` names a per-address count of its own beside the door's default (`ip`), for a call the same caller
   * legitimately repeats more often (the enrolment poll, #634).
   */
  async hitAddress(
    header: string | undefined,
    limit: number,
    logger: Logger,
    bucket = 'ip',
  ): Promise<boolean> {
    const address = rateLimitAddressOf(header);
    if (address.kind === 'unknown') {
      // The edge always sets it; without it the caller is not reaching us through Cloudflare (or the header is forged).
      logger.warn('runner door without a client address', { door: this.scope });
    }
    const unit = address.kind === 'unknown' ? 'unknown' : await sha256Hex(address.key);
    return (await this.repo.hit(`${this.scope}:${bucket}:${unit}`, this.window, limit)).allowed;
  }

  async hitUnverified(limit: number): Promise<boolean> {
    return this.hit('unverified', limit);
  }

  async hitVerified(limit: number): Promise<boolean> {
    return this.hit('verified', limit);
  }

  /** One hit on a bucket of the door's own, in the same window (the exchange's per-repository count). */
  async hit(bucket: string, limit: number): Promise<boolean> {
    return (await this.repo.hit(`${this.scope}:${bucket}`, this.window, limit)).allowed;
  }

  /** `Retry-After` for a 429 of this request: the rest of its window. */
  retryAfter(): number {
    return retryAfterOf(this.now, WINDOW_SECONDS);
  }
}
