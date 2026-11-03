import { appIconDirOf, environmentLabelOf, isValidSlug, type Environment } from '@shared/contracts';
import { PUSH_COPY, type PushLanguage } from './copy';

/** Title and body are cut to this many characters, the ellipsis included (threat model on #11, row 6). */
export const PUSH_TEXT_MAX_LENGTH = 120;

/** Where the test notification leads: the cross-project Needs you list. */
export const PUSH_TEST_URL = '/needs-you';

const iconOf = (environment: Environment): string => `${appIconDirOf(environment)}/icon-192.png`;
const ICON = iconOf('production');

/**
 * The Angular service worker's `notification` payload: ngsw shows it and, on a tap, runs `onActionClick.default`
 * with no code of ours (ADR 0001 decision 3). The URL is always a same-origin path built here.
 */
export interface PushNotification {
  readonly notification: {
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly icon: string;
    readonly lang: PushLanguage;
    readonly data: {
      readonly onActionClick: {
        readonly default: { readonly operation: 'navigateLastFocusedOrOpen'; readonly url: string };
      };
    };
  };
}

export class InvalidPushTargetError extends Error {
  constructor(what: 'slug' | 'number' | 'url') {
    super(`a push target needs a valid project ${what}`);
    this.name = 'InvalidPushTargetError';
  }
}

// Bidi marks, overrides and isolates are dropped: they can make the text read differently from what it is.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

// Invisible characters that let a title hide or smuggle text (security review of #165): zero-width space, joiners
// and the LRM/RLM marks, word joiner and invisible operators, the BOM, and the Unicode tag block.
const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF]|\u{E0000}|[\u{E0001}-\u{E007F}]/gu;

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** One line of plain text for a lock screen: no controls, no bidi tricks, no invisibles, at most 120 characters. */
export function cleanPushText(text: string): string {
  const spaced = [...text.replace(BIDI, '').replace(INVISIBLE, '')]
    .map((char) => (isControl(char) ? ' ' : char))
    .join('');
  const flat = spaced.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= PUSH_TEXT_MAX_LENGTH ? flat : `${chars.slice(0, PUSH_TEXT_MAX_LENGTH - 1).join('').trimEnd()}…`;
}

function assertTarget(slug: string, number: number): void {
  if (!isValidSlug(slug)) {
    throw new InvalidPushTargetError('slug');
  }
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new InvalidPushTargetError('number');
  }
}

/** `/p/{slug}/questions#{n}`: a relative path to the item in its project space, never another origin. */
export function questionPushUrl(slug: string, number: number): string {
  assertTarget(slug, number);
  return `/p/${slug}/questions#${String(number)}`;
}

function notification(
  language: PushLanguage,
  title: string,
  body: string,
  tag: string,
  url: string,
): PushNotification {
  return {
    notification: {
      title: cleanPushText(title),
      body: cleanPushText(body),
      tag,
      icon: ICON,
      lang: language,
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } },
    },
  };
}

export interface QuestionPushInput {
  readonly language: PushLanguage;
  readonly slug: string;
  /** What the owner calls the project; untrusted text, cleaned like the title. */
  readonly projectName: string;
  readonly number: number;
  /** The issue title from GitHub: untrusted. */
  readonly issueTitle: string;
}

/** An item that waits for the owner's answer (built by the hooks Worker in #12). */
export function questionNotification(input: QuestionPushInput): PushNotification {
  const url = questionPushUrl(input.slug, input.number);
  return notification(
    input.language,
    PUSH_COPY[input.language].questionTitle(cleanPushText(input.projectName)),
    `#${String(input.number)} ${input.issueTitle}`,
    `p/${input.slug}/questions/${String(input.number)}`,
    url,
  );
}

/** A same-origin path, optionally with a digits-only fragment: never another origin, scheme or query. */
const SAME_ORIGIN_PATH = /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*(?:#[0-9]+)?$/;

export interface LinkNotificationInput {
  readonly language: PushLanguage;
  /** May carry untrusted text; cleaned like every notification text. */
  readonly title: string;
  readonly body: string;
  /** A path the caller built from trusted parts, e.g. `/p/{slug}/board`. */
  readonly url: string;
}

/**
 * Any other notification of the hooks Worker (#12): PM replied, team paused, release ready, deploy failed, access
 * lost. The tag is the url, so a repeat of the same event replaces the earlier notification on the device.
 */
export function linkNotification(input: LinkNotificationInput): PushNotification {
  if (!SAME_ORIGIN_PATH.test(input.url)) {
    throw new InvalidPushTargetError('url');
  }
  return notification(input.language, input.title, input.body, input.url, input.url);
}

/**
 * The notification as the environment that sends it shows it (#237): outside production the title starts with
 * `[Dev] ` / `[Stage] ` / `[Local] ` and the icon is that environment's, so a lock screen never passes a dev item off
 * as a production one. Production's is returned unchanged.
 */
export function forEnvironment(message: PushNotification, environment: Environment): PushNotification {
  const label = environmentLabelOf(environment);
  if (label === null) {
    return message;
  }
  return {
    notification: {
      ...message.notification,
      // Cleaned again so the prefixed title still fits the 120-character cut.
      title: cleanPushText(`[${label}] ${message.notification.title}`),
      icon: iconOf(environment),
    },
  };
}

/** "Send a test" from Settings (#36): fixed text, opens Needs you. */
export function testNotification(language: PushLanguage): PushNotification {
  const copy = PUSH_COPY[language];
  return notification(language, copy.testTitle, copy.testBody, 'test', PUSH_TEST_URL);
}
