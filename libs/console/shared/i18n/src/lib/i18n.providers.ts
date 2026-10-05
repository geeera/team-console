import { DOCUMENT } from '@angular/common';
import {
  EnvironmentProviders,
  inject,
  isDevMode,
  provideAppInitializer,
  provideEnvironmentInitializer,
} from '@angular/core';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { ConsoleLanguage } from './language-preference';
import { CONSOLE_LANGS, ConsoleLang, DEFAULT_LANG } from './languages';
import { StaticTranslationLoader } from './static-translation-loader';

/** Keeps `<html lang>` in step with the active language so screen readers switch voice. */
function syncDocumentLang(): void {
  const document = inject(DOCUMENT);
  const transloco = inject(TranslocoService);
  transloco.langChanges$.subscribe((lang) => {
    document.documentElement.lang = lang;
  });
}

export interface ConsoleI18nOptions {
  /**
   * `remembered` — the app: the language stored on this device, else the device's own (#4).
   * `reference` (default) — specs and Storybook: always the Russian reference copy, whatever the runner's locale or
   * an earlier spec stored.
   */
  readonly start?: 'remembered' | 'reference';
}

export function provideConsoleI18n({ start = 'reference' }: ConsoleI18nOptions = {}): EnvironmentProviders[] {
  return [
    ...provideTransloco({
      config: {
        availableLangs: [...CONSOLE_LANGS],
        defaultLang: DEFAULT_LANG,
        fallbackLang: DEFAULT_LANG,
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
        missingHandler: { logMissingKey: isDevMode(), useFallbackTranslation: true, allowEmpty: false },
      },
      loader: StaticTranslationLoader,
    }),
    provideEnvironmentInitializer(syncDocumentLang),
    provideAppInitializer(() =>
      startIn(start === 'remembered' ? inject(ConsoleLanguage).initial() : DEFAULT_LANG),
    ),
  ];
}

/**
 * Before the first render. The loader is synchronous, so the first paint is already in `lang` — no flash of the
 * other language.
 */
function startIn(lang: ConsoleLang): Observable<unknown> {
  const transloco = inject(TranslocoService);
  transloco.setActiveLang(lang);
  return transloco.load(lang);
}
