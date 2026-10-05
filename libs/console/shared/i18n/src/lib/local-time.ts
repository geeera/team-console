import { ChangeDetectorRef, inject, Pipe, PipeTransform } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { intlLocaleOf } from './languages';

function dateOf(value: string | Date | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "13:35" in the reader's time zone; an unreadable value gives an empty string rather than "Invalid Date". */
export function localTimeOf(value: string | Date | number, lang: string): string {
  const date = dateOf(value);
  return date === null
    ? ''
    : new Intl.DateTimeFormat(intlLocaleOf(lang), { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** "28 сентября" / "28 September". */
export function localDayOf(value: string | Date | number, lang: string): string {
  const date = dateOf(value);
  return date === null
    ? ''
    : new Intl.DateTimeFormat(intlLocaleOf(lang), { day: 'numeric', month: 'long' }).format(date);
}

/**
 * "1 234" / "1,234" — a count in the active language. Not for issue numbers or versions, which are identifiers
 * (`#1234`), not quantities. A non-finite value gives an empty string rather than "NaN".
 */
export function localNumberOf(value: number, lang: string): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(intlLocaleOf(lang)).format(value) : '';
}

abstract class LocalisedPipe {
  protected readonly transloco = inject(TranslocoService);

  constructor() {
    const changes = inject(ChangeDetectorRef);
    this.transloco.langChanges$.pipe(takeUntilDestroyed()).subscribe(() => changes.markForCheck());
  }
}

/** `{{ checkedAt | localTime }}` in the active language. */
@Pipe({ name: 'localTime', pure: false })
export class LocalTimePipe extends LocalisedPipe implements PipeTransform {
  transform(value: string | Date | number | null | undefined): string {
    return value === null || value === undefined ? '' : localTimeOf(value, this.transloco.getActiveLang());
  }
}

/** `{{ connectedAt | localDay }}` in the active language. */
@Pipe({ name: 'localDay', pure: false })
export class LocalDayPipe extends LocalisedPipe implements PipeTransform {
  transform(value: string | Date | number | null | undefined): string {
    return value === null || value === undefined ? '' : localDayOf(value, this.transloco.getActiveLang());
  }
}

/** `{{ count | localNumber }}` in the active language. */
@Pipe({ name: 'localNumber', pure: false })
export class LocalNumberPipe extends LocalisedPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return value === null || value === undefined ? '' : localNumberOf(value, this.transloco.getActiveLang());
  }
}
