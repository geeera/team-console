/**
 * Notification copy. The Worker has no Transloco, so the two languages of `owner.language` live here (architect note
 * on #11); the wording follows the approved #36 design, with the polite «вы» (owner decision 2026-10-01).
 */
export type PushLanguage = 'ru' | 'en';

export function isPushLanguage(value: unknown): value is PushLanguage {
  return value === 'ru' || value === 'en';
}

interface PushCopy {
  readonly questionTitle: (project: string) => string;
  readonly testTitle: string;
  readonly testBody: string;
}

export const PUSH_COPY: Readonly<Record<PushLanguage, PushCopy>> = {
  ru: {
    questionTitle: (project) => `${project} · нужен ваш ответ`,
    testTitle: 'Тестовое уведомление',
    testBody: 'Работает. Нажмите, чтобы открыть «Ждут вас».',
  },
  en: {
    questionTitle: (project) => `${project} · your answer is needed`,
    testTitle: 'Test notification',
    testBody: 'It works. Tap to open Needs you.',
  },
};
