import type { Logger } from '@worker/core';
import { PushSubscriptionsRepo } from '@worker/db';
import {
  PushMisconfiguredError,
  PushSender,
  checkVapidConfig,
  pushFetch,
  type FetchLike,
  type PushNotification,
  type PushSendResult,
} from '@worker/push';
import type { HooksEnv } from '../env';

/** Sends one notification to every device of the owner (#11's fan-out). */
export interface NotificationSender {
  sendToAll(notification: PushNotification): Promise<PushSendResult>;
}

/**
 * Builds the sender for one request's bindings, or `null` (logged by setting name, never by value) when push is not
 * configured here: the delivery still succeeds, GitHub must not retry it for a missing key.
 */
export type NotificationSenderFactory = (env: HooksEnv, logger: Logger) => NotificationSender | null;

/** The real web push sender of `@worker/push` over `push_subscriptions`; `baseFetch` is a test seam. */
export function webPushSenders(baseFetch: FetchLike): NotificationSenderFactory {
  return (env, logger) => {
    const vapid = checkVapidConfig({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    });
    if (!vapid.ok) {
      logger.error('push misconfigured', { invalid: vapid.invalid });
      return null;
    }
    let transport: FetchLike;
    try {
      transport = pushFetch(env, baseFetch);
    } catch (error: unknown) {
      if (!(error instanceof PushMisconfiguredError)) {
        throw error;
      }
      logger.error('push misconfigured', { invalid: ['PUSH_FAKE_ORIGIN'] });
      return null;
    }
    const sender = new PushSender({ vapid: vapid.config, fetch: transport, logger });
    const store = new PushSubscriptionsRepo(env.DB);
    return { sendToAll: (notification) => sender.sendToAll(store, notification) };
  };
}
