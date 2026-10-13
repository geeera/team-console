import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { from, map, Observable, of, throwError } from 'rxjs';
import { isConsoleLang } from './languages';
import ru from './locales/ru.json';

/**
 * Russian — the reference copy and Transloco's fallback, loaded beside whichever language is active — ships inside
 * the initial bundle and loads synchronously, so the first paint works offline.
 *
 * English is its own lazy chunk (#123), kept out of the initial bundle: the start initializer waits for it before
 * the first render, so an English start shows no flash of Russian, and the service worker prefetches every `*.js`
 * on install (`ngsw-config.json`, group `app`), so an offline English start finds it on the device.
 */
@Injectable({ providedIn: 'root' })
export class StaticTranslationLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    if (!isConsoleLang(lang)) {
      return throwError(() => new Error(`Unsupported language "${lang}"`));
    }
    if (lang === 'ru') {
      return of(ru);
    }
    return from(import('./locales/en.json')).pipe(map((module): Translation => module.default));
  }
}
