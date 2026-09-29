import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { Observable, of, throwError } from 'rxjs';
import { ConsoleLang, isConsoleLang } from './languages';
import en from './locales/en.json';
import ru from './locales/ru.json';

const TRANSLATIONS: Record<ConsoleLang, Translation> = { ru, en };

/**
 * Both dictionaries ship inside the bundle: they are small, there is no API
 * to fetch them from yet, and the PWA must render offline from the first paint.
 */
@Injectable({ providedIn: 'root' })
export class StaticTranslationLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    if (!isConsoleLang(lang)) {
      return throwError(() => new Error(`Unsupported language "${lang}"`));
    }
    return of(TRANSLATIONS[lang]);
  }
}
