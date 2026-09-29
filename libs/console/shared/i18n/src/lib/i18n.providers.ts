import { DOCUMENT } from '@angular/common';
import {
  EnvironmentProviders,
  inject,
  isDevMode,
  provideAppInitializer,
  provideEnvironmentInitializer,
} from '@angular/core';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { CONSOLE_LANGS, DEFAULT_LANG } from './languages';
import { StaticTranslationLoader } from './static-translation-loader';

/** Keeps `<html lang>` in step with the active language so screen readers switch voice. */
function syncDocumentLang(): void {
  const document = inject(DOCUMENT);
  const transloco = inject(TranslocoService);
  transloco.langChanges$.subscribe((lang) => {
    document.documentElement.lang = lang;
  });
}

export function provideConsoleI18n(): EnvironmentProviders[] {
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
    // The loader is synchronous, so the first render already has the reference copy.
    provideAppInitializer(() => inject(TranslocoService).load(DEFAULT_LANG)),
  ];
}
