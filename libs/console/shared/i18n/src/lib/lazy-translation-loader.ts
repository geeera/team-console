import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { from, map, Observable, throwError } from 'rxjs';
import { ConsoleLang, isConsoleLang } from './languages';

/** Each catalogue is its own lazy chunk; nothing here is imported statically. */
const CATALOGUES: Readonly<Record<ConsoleLang, () => Promise<{ default: Translation }>>> = {
  ru: () => import('./locales/ru.json'),
  en: () => import('./locales/en.json'),
};

export function loadCatalogue(lang: string): Observable<Translation> {
  if (!isConsoleLang(lang)) {
    return throwError(() => new Error(`Unsupported language "${lang}"`));
  }
  return from(CATALOGUES[lang]()).pipe(map((module): Translation => module.default));
}

/**
 * The app's loader (#433): every catalogue, Russian included, is a lazy chunk, so the initial bundle carries none.
 * The start initializer waits for the active one (and Transloco for the Russian fallback beside it) before the first
 * render, so there is no flash of keys or of the other language; the service worker prefetches every `*.js` on
 * install (`ngsw-config.json`, group `app`), so an offline start finds both on the device.
 */
@Injectable({ providedIn: 'root' })
export class LazyTranslationLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    return loadCatalogue(lang);
  }
}
