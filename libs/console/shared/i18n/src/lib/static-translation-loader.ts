import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { Observable, of } from 'rxjs';
import { loadCatalogue } from './lazy-translation-loader';
import ru from './locales/ru.json';

/**
 * Specs and Storybook only (`provideConsoleI18n()`): the Russian reference copy inline, handed out synchronously, so
 * a spec renders it without awaiting a chunk. English still comes from its lazy chunk. The app never reaches this
 * file — it would put the whole Russian catalogue back into the initial bundle (#433); it uses
 * `LazyTranslationLoader` through `provideConsoleAppI18n()`.
 */
@Injectable({ providedIn: 'root' })
export class StaticTranslationLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    return lang === 'ru' ? of(ru) : loadCatalogue(lang);
  }
}
