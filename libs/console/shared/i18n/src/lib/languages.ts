/** Russian is the reference copy (ADR 0002, decision 2); English is the second language. */
export const CONSOLE_LANGS = ['ru', 'en'] as const;

export type ConsoleLang = (typeof CONSOLE_LANGS)[number];

/** The reference copy: Transloco's fallback for a missing key, and Storybook's starting language. */
export const DEFAULT_LANG: ConsoleLang = 'ru';

/** What a device whose language the console does not speak gets on first launch (#4). */
export const FOREIGN_DEVICE_LANG: ConsoleLang = 'en';

export function isConsoleLang(value: unknown): value is ConsoleLang {
  return typeof value === 'string' && (CONSOLE_LANGS as readonly string[]).includes(value);
}

/**
 * The language a first launch starts in: the device's own (its first preferred language, `navigator.languages[0]`)
 * when it is ru or en in any region (`ru-UA`, `en-US`), English for anything else (#4).
 */
export function deviceLangOf(languages: readonly string[]): ConsoleLang {
  const primary = languages[0]?.split('-')[0]?.toLowerCase();
  return isConsoleLang(primary) ? primary : FOREIGN_DEVICE_LANG;
}

const INTL_LOCALES: Readonly<Record<ConsoleLang, string>> = { ru: 'ru-RU', en: 'en-GB' };

/** The `Intl` locale for a console language; anything else is handed to `Intl` as it is. */
export function intlLocaleOf(lang: string): string {
  return isConsoleLang(lang) ? INTL_LOCALES[lang] : lang;
}
