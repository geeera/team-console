import { ChangeDetectorRef, inject, Pipe, PipeTransform } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';

const LOCALES: Readonly<Record<string, string>> = { ru: 'ru-RU', en: 'en-GB' };

function dateOf(value: string | Date | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "13:35" in the reader's time zone; an unreadable value gives an empty string rather than "Invalid Date". */
export function localTimeOf(value: string | Date | number, lang: string): string {
  const date = dateOf(value);
  return date === null
    ? ''
    : new Intl.DateTimeFormat(LOCALES[lang] ?? lang, { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** "28 сентября" / "28 September". */
export function localDayOf(value: string | Date | number, lang: string): string {
  const date = dateOf(value);
  return date === null
    ? ''
    : new Intl.DateTimeFormat(LOCALES[lang] ?? lang, { day: 'numeric', month: 'long' }).format(date);
}

abstract class LocalisedPipe implements PipeTransform {
  protected readonly transloco = inject(TranslocoService);

  constructor() {
    const changes = inject(ChangeDetectorRef);
    this.transloco.langChanges$.pipe(takeUntilDestroyed()).subscribe(() => changes.markForCheck());
  }

  abstract transform(value: string | Date | number | null | undefined): string;
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
