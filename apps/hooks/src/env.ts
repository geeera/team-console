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
  /** Secret (#11): the VAPID private scalar, base64url; the same pair as the api Worker's. Never logged. */
  readonly VAPID_PRIVATE_KEY?: string;
  /** Non-secret var (#11/#12): the VAPID public key, empty in the repository; deploy.yml passes `vars.VAPID_PUBLIC_KEY`. */
  readonly VAPID_PUBLIC_KEY?: string;
  /** Non-secret var (#11/#12): the JWT `sub`, an https URL (never the owner's e-mail in this public repo). */
  readonly VAPID_SUBJECT?: string;
  /**
   * A loopback origin of the fake push service (`nx run api:fake-push`) that pushes go to instead of Apple, FCM or
   * Mozilla; honoured only with ENVIRONMENT=local, passed only as `--var`.
   */
  readonly PUSH_FAKE_ORIGIN?: string;
}
