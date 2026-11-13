import { createHash, timingSafeEqual } from 'node:crypto';
import type { ProxyJob } from './router';

/**
 * The jobs this runner launched and their tokens (ADR 0006 "Key agent and proxy"): the socket answers only a token
 * it finds here. Only a SHA-256 of each token is held, compared in constant time; a job is dropped at its finish so
 * its token stops working on the socket before the console refuses it too.
 */
interface Entry {
  readonly job: ProxyJob;
  readonly tokenDigest: Buffer;
}

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export class JobRegistry {
  private readonly entries = new Map<string, Entry>();

  register(job: ProxyJob, token: string): void {
    if (this.entries.has(job.id)) {
      throw new Error(`job ${job.id} is already registered`);
    }
    this.entries.set(job.id, {
      job: { id: job.id, projectSlug: job.projectSlug },
      tokenDigest: digestOf(token),
    });
  }

  drop(jobId: string): void {
    this.entries.delete(jobId);
  }

  /** The job a presented token belongs to, or `null`. Every entry is compared, so the timing names no position. */
  jobOfToken(token: string): ProxyJob | null {
    const presented = digestOf(token);
    let found: ProxyJob | null = null;
    for (const entry of this.entries.values()) {
      if (timingSafeEqual(entry.tokenDigest, presented)) {
        found = entry.job;
      }
    }
    return found;
  }
}
