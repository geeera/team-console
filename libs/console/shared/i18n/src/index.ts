export { provideConsoleI18n } from './lib/i18n.providers';
export { CONSOLE_LANGS, DEFAULT_LANG, isConsoleLang } from './lib/languages';
export type { ConsoleLang } from './lib/languages';
// The Transloco surface consumers may use; swapping the i18n library later touches only this lib.
export { TranslocoDirective, TranslocoPipe, TranslocoService, translateSignal } from '@jsverse/transloco';
