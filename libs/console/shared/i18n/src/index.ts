export { provideConsoleI18n } from './lib/i18n.providers';
export type { ConsoleI18nOptions } from './lib/i18n.providers';
export {
  CONSOLE_LANGS,
  DEFAULT_LANG,
  FOREIGN_DEVICE_LANG,
  deviceLangOf,
  intlLocaleOf,
  isConsoleLang,
} from './lib/languages';
export {
  ConsoleLanguage,
  DEVICE_LANGUAGES,
  LANGUAGE_STORAGE,
  LANG_STORAGE_KEY,
  initialLangOf,
  memoryLanguageStorage,
} from './lib/language-preference';
export type { LanguageStorage } from './lib/language-preference';
export type { ConsoleLang } from './lib/languages';
export { PLURAL_CATEGORIES, TranslocoPluralPipe, pluralCategoryOf, pluralKeyOf } from './lib/plural';
export type { PluralCategory } from './lib/plural';
export {
  LocalDayPipe,
  LocalNumberPipe,
  LocalTimePipe,
  localCalendarDayOf,
  localCalendarRangeOf,
  localDayOf,
  localNumberOf,
  localTimeOf,
} from './lib/local-time';
// The Transloco surface consumers may use; swapping the i18n library later touches only this lib.
export { TranslocoDirective, TranslocoPipe, TranslocoService, translateSignal } from '@jsverse/transloco';
