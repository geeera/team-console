export type PushLanguage = 'ru' | 'en';

export type PushKind =
  'decision' | 'pm-reply' | 'team-paused' | 'release-ready' | 'deploy-failed' | 'access-lost';

/**
 * One notification for the owner, built by the mapping (#12). `title`/`body` may carry GitHub text (issue titles):
 * the sender of #11 cleans and truncates them before they reach a lock screen (threat model on #11, row 6). `url`
 * is a same-origin path built from the slug and an integer only; `tag` is the url, so repeats collapse on the device.
 */
export interface PushMessage {
  readonly kind: PushKind;
  readonly slug: string;
  readonly language: PushLanguage;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag: string;
}

/** What a fan-out did: delivered, subscriptions pruned as gone, and failures. */
export interface PushFanOut {
  readonly sent: number;
  readonly pruned: number;
  readonly failed: number;
}

/** The seam to #11's `sendToAll`; the hooks Worker never talks to a push service any other way. */
export interface PushSender {
  sendToAll(message: PushMessage): Promise<PushFanOut>;
}

/**
 * Until #11's sender is wired into this Worker (it needs `VAPID_PRIVATE_KEY` and the subscriptions table), mapped
 * pushes are counted and dropped.
 */
export const noopPushSender: PushSender = {
  sendToAll: () => Promise.resolve({ sent: 0, pruned: 0, failed: 0 }),
};
