import type { WorkerBaseEnv } from '@worker/core';

/**
 * Bindings of the public `hooks` Worker. Deliberately no GitHub credential of any kind (ADR 0003 decision 8;
 * tools/workspace-checks enforces it): it holds only what webhooks and push need.
 */
export interface HooksEnv extends WorkerBaseEnv {
  /** Secret (#12): this environment's GitHub App webhook secret (ADR 0003 decision 5). Unset or empty fails closed. */
  readonly WEBHOOK_SECRET?: string;
  /** Secret (#12): the previous webhook secret, set only while a rotation is in progress (ADR 0003 decision 5). */
  readonly WEBHOOK_SECRET_PREVIOUS?: string;
  /** Secret (#11). */
  readonly VAPID_PRIVATE_KEY?: string;
}
