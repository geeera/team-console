import type { WorkerBaseEnv } from '@worker/core';

/** Bindings of the public `hooks` Worker. Deliberately no GITHUB_TOKEN: it holds only what webhooks and push need. */
export interface HooksEnv extends WorkerBaseEnv {
  /** Secret (#12): one shared secret for every product's webhook. */
  readonly WEBHOOK_SECRET?: string;
  /** Secret (#11). */
  readonly VAPID_PRIVATE_KEY?: string;
}
