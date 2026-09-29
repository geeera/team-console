/** Russian is the reference copy (ADR 0002, decision 2); English is the second language. */
export const CONSOLE_LANGS = ['ru', 'en'] as const;

export type ConsoleLang = (typeof CONSOLE_LANGS)[number];

export const DEFAULT_LANG: ConsoleLang = 'ru';

export function isConsoleLang(value: unknown): value is ConsoleLang {
  return typeof value === 'string' && (CONSOLE_LANGS as readonly string[]).includes(value);
}
