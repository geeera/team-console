import { DOCUMENT } from '@angular/common';
import {
  EnvironmentProviders,
  inject,
  isDevMode,
  provideAppInitializer,
  provideEnvironmentInitializer,
  Type,
} from '@angular/core';
import { provideTransloco, TranslocoLoader, TranslocoService } from '@jsverse/transloco';
import { catchError, of, tap, type Observable } from 'rxjs';
import { ConsoleLanguage } from './language-preference';
import { CONSOLE_LANGS, ConsoleLang, DEFAULT_LANG } from './languages';
import { LazyTranslationLoader } from './lazy-translation-loader';
import { StaticTranslationLoader } from './static-translation-loader';

/** Keeps `<html lang>` in step with the active language so screen readers switch voice. */
function syncDocumentLang(): void {
  const document = inject(DOCUMENT);
  const transloco = inject(TranslocoService);
  transloco.langChanges$.subscribe((lang) => {
    document.documentElement.lang = lang;
  });
}

/**
 * The app (#4, #433): starts in the language stored on this device, else the device's own; every catalogue is a lazy
 * chunk. The app must call this, never `provideConsoleI18n()` — `initial-bundle.spec.ts` checks it.
 */
export function provideConsoleAppI18n(): EnvironmentProviders[] {
  return consoleI18n(LazyTranslationLoader, () => inject(ConsoleLanguage).initial());
}

/**
 * Specs and Storybook: always the Russian reference copy, whatever the runner's locale or an earlier spec stored,
 * and inline, so it is there synchronously.
 */
export function provideConsoleI18n(): EnvironmentProviders[] {
  return consoleI18n(StaticTranslationLoader, () => DEFAULT_LANG);
}

function consoleI18n(loader: Type<TranslocoLoader>, startLang: () => ConsoleLang): EnvironmentProviders[] {
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
      loader,
    }),
    provideEnvironmentInitializer(syncDocumentLang),
    provideAppInitializer(() => startIn(startLang())),
  ];
}

/**
 * Before the first render: the dictionary loads first, then the language is set, so the first paint is already in
 * `lang` — no flash of keys or of the other one. A dictionary that cannot load falls back to the reference copy; if
 * that cannot load either (a chunk gone after a deploy), the app still starts, so the update flow (#306) can heal it,
 * rather than a blank page that nothing reloads.
 */
function startIn(lang: ConsoleLang): Observable<unknown> {
  const transloco = inject(TranslocoService);
  return transloco.load(lang).pipe(
    tap(() => transloco.setActiveLang(lang)),
    catchError((error: unknown) => {
      console.warn(`i18n: could not load "${lang}"; starting in "${DEFAULT_LANG}"`, error);
      return transloco.load(DEFAULT_LANG).pipe(
        tap(() => transloco.setActiveLang(DEFAULT_LANG)),
        catchError((fallbackError: unknown) => {
          console.error(`i18n: could not load "${DEFAULT_LANG}" either; starting without a dictionary`, fallbackError);
          return of(null);
        }),
      );
    }),
  );
}
