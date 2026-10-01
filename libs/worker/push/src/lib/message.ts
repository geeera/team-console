import { isValidSlug } from '@shared/contracts';
import { PUSH_COPY, type PushLanguage } from './copy';

/** Title and body are cut to this many characters, the ellipsis included (threat model on #11, row 6). */
export const PUSH_TEXT_MAX_LENGTH = 120;

/** Where the test notification leads: the cross-project Needs you list. */
export const PUSH_TEST_URL = '/needs-you';

const ICON = '/icons/icon-192.png';

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
  constructor(what: 'slug' | 'number') {
    super(`a push target needs a valid project ${what}`);
    this.name = 'InvalidPushTargetError';
  }
}

// Bidi marks, overrides and isolates are dropped: they can make the text read differently from what it is.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** One line of plain text for a lock screen: no controls, no bidi tricks, at most 120 characters. */
export function cleanPushText(text: string): string {
  const spaced = [...text.replace(BIDI, '')].map((char) => (isControl(char) ? ' ' : char)).join('');
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

/** "Send a test" from Settings (#36): fixed text, opens Needs you. */
export function testNotification(language: PushLanguage): PushNotification {
  const copy = PUSH_COPY[language];
  return notification(language, copy.testTitle, copy.testBody, 'test', PUSH_TEST_URL);
}
