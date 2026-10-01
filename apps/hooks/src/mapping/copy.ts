import type { PushLanguage } from '@worker/push';

/** The notifications the hooks Worker sends besides "your answer is needed" (that one is `questionNotification`). */
export type LinkPushKind = 'pm-reply' | 'team-paused' | 'release-ready' | 'deploy-failed' | 'access-lost';

/** The values a line of copy may interpolate; each kind uses its own subset. */
export interface CopyInput {
  readonly project: string;
  readonly number?: number;
  readonly title?: string;
  readonly environment?: string;
  readonly repo?: string;
}

interface Line {
  readonly title: (input: CopyInput) => string;
  readonly body: (input: CopyInput) => string;
}

const itemLine = (input: CopyInput): string => `#${String(input.number ?? '')} ${input.title ?? ''}`.trim();

/**
 * Push copy per `owner.language`. The Worker has no i18n runtime, so both languages live in this table (architect
 * note on #12); polite «вы» as decided for #11/#36 on 2026-10-01. `@worker/push` cleans and truncates every text.
 */
export const PUSH_COPY: Readonly<Record<PushLanguage, Readonly<Record<LinkPushKind, Line>>>> = {
  ru: {
    'pm-reply': { title: (i) => `${i.project} · PM ответил`, body: itemLine },
    'team-paused': {
      title: (i) => `${i.project} · команда на паузе`,
      body: () => 'Откройте доску, чтобы продолжить.',
    },
    'release-ready': { title: (i) => `${i.project} · релиз готов к go/no-go`, body: itemLine },
    'deploy-failed': {
      title: (i) => `${i.project} · деплой упал: ${i.environment ?? ''}`,
      body: () => 'Откройте доску.',
    },
    'access-lost': {
      title: (i) => `${i.project} · консоль потеряла доступ к ${i.repo ?? ''}`,
      body: () => 'Установите приложение на репозиторий снова.',
    },
  },
  en: {
    'pm-reply': { title: (i) => `${i.project} · PM replied`, body: itemLine },
    'team-paused': {
      title: (i) => `${i.project} · the team is paused`,
      body: () => 'Open the board to resume.',
    },
    'release-ready': { title: (i) => `${i.project} · release ready for go/no-go`, body: itemLine },
    'deploy-failed': {
      title: (i) => `${i.project} · deploy failed: ${i.environment ?? ''}`,
      body: () => 'Open the board.',
    },
    'access-lost': {
      title: (i) => `${i.project} · the console lost access to ${i.repo ?? ''}`,
      body: () => 'Install the app on the repository again.',
    },
  },
};
