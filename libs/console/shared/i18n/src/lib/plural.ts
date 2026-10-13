import { ChangeDetectorRef, inject, Pipe, PipeTransform } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { catchError, of, switchMap } from 'rxjs';
import { localNumberOf } from './local-time';

/**
 * The plural forms the catalogue spells out. Russian needs one/few/many, English one/other; every counted key has
 * all four in both files (the locale test keeps the key sets equal), English repeating its "other" form.
 */
export const PLURAL_CATEGORIES = ['one', 'few', 'many', 'other'] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

function isCatalogueCategory(value: string): value is PluralCategory {
  return (PLURAL_CATEGORIES as readonly string[]).includes(value);
}

/** CLDR's category for `n` in `lang`; `zero` and `two` (not used by ru or en) fall back to `other`. */
export function pluralCategoryOf(lang: string, n: number): PluralCategory {
  const category = new Intl.PluralRules(lang).select(n);
  return isCatalogueCategory(category) ? category : 'other';
}

/** `projects.row.missing` + 3 in ru → `projects.row.missing.few`. */
export function pluralKeyOf(key: string, lang: string, n: number): string {
  return `${key}.${pluralCategoryOf(lang, n)}`;
}

/**
 * `{{ 'setup.incomplete.title' | translocoPlural: n }}` — the counted form of a key, with `n` (formatted through
 * `Intl` in the active language) and any further params interpolated. Re-renders on a language switch like
 * Transloco's own pipe: once the language's dictionary has loaded, not merely when the language changes — English is
 * a lazy chunk (#123), and a switch that lands before it would otherwise leave the fallback copy on screen.
 */
@Pipe({ name: 'translocoPlural', pure: false })
export class TranslocoPluralPipe implements PipeTransform {
  private readonly transloco = inject(TranslocoService);

  constructor() {
    const changes = inject(ChangeDetectorRef);
    this.transloco.langChanges$
      .pipe(
        // A dictionary that cannot load still re-renders, in whatever Transloco falls back to.
        switchMap((lang) => this.transloco.load(lang).pipe(catchError(() => of(null)))),
        takeUntilDestroyed(),
      )
      .subscribe(() => changes.markForCheck());
  }

  transform(key: string, n: number, params: Readonly<Record<string, unknown>> = {}): string {
    const lang = this.transloco.getActiveLang();
    return this.transloco.translate(pluralKeyOf(key, lang, n), { ...params, n: localNumberOf(n, lang) });
  }
}
