import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, InjectionToken, Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { ConsoleLang, DEFAULT_LANG, deviceLangOf, isConsoleLang } from './languages';

/** Device-local, never sent to the Worker; its own key so the `tc.state.v1` shape stays as it is. */
export const LANG_STORAGE_KEY = 'tc.lang.v1';

/** The one storage seam of the language choice; specs supply an in-memory one. */
export interface LanguageStorage {
  /** Null when nothing is stored or storage is unavailable. */
  read(): string | null;
  /** May throw (quota, storage disabled); the caller keeps the language in memory then. */
  write(value: string): void;
}

export const LANGUAGE_STORAGE = new InjectionToken<LanguageStorage>('LANGUAGE_STORAGE', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return {
      read: () => {
        try {
          return view?.localStorage.getItem(LANG_STORAGE_KEY) ?? null;
        } catch {
          // Storage disabled: behave like a first launch.
          return null;
        }
      },
      write: (value) => {
        view?.localStorage.setItem(LANG_STORAGE_KEY, value);
      },
    };
  },
});

/** The device's preferred languages, most preferred first (iOS: Settings › General › Language & Region). */
export const DEVICE_LANGUAGES = new InjectionToken<readonly string[]>('DEVICE_LANGUAGES', {
  providedIn: 'root',
  factory: () => {
    const navigator = inject(DOCUMENT).defaultView?.navigator;
    if (navigator === undefined) {
      return [];
    }
    return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  },
});

export function memoryLanguageStorage(
  initial: string | null = null,
): LanguageStorage & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(value: string) {
      this.value = value;
    },
  };
}

/** The stored choice wins; without one (or with a value the console no longer ships) the device decides. */
export function initialLangOf(stored: string | null, deviceLanguages: readonly string[]): ConsoleLang {
  return isConsoleLang(stored) ? stored : deviceLangOf(deviceLanguages);
}

/**
 * The interface language (#4): picked on start from the stored choice or the device, switched in Settings, and
 * remembered on the device so it survives a reload and an iOS PWA restart.
 */
@Injectable({ providedIn: 'root' })
export class ConsoleLanguage {
  private readonly transloco = inject(TranslocoService);
  private readonly storage = inject(LANGUAGE_STORAGE);
  private readonly deviceLanguages = inject(DEVICE_LANGUAGES);
  private reportedWriteFailure = false;

  private readonly translocoLang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  /** The active language; computeds that call `translate()` read it so a switch re-runs them. */
  readonly active: Signal<ConsoleLang> = computed(() => {
    const lang = this.translocoLang();
    return isConsoleLang(lang) ? lang : DEFAULT_LANG;
  });

  /** The language this launch starts in. */
  initial(): ConsoleLang {
    return initialLangOf(this.storage.read(), this.deviceLanguages);
  }

  /** Switches the whole interface without a reload and remembers the choice on this device. */
  use(lang: ConsoleLang): void {
    this.transloco.setActiveLang(lang);
    try {
      this.storage.write(lang);
    } catch (error: unknown) {
      // The switch still applies for this session; say so once, never throw.
      if (!this.reportedWriteFailure) {
        this.reportedWriteFailure = true;
        console.warn('i18n: could not store the language choice; it lasts until the app closes', error);
      }
    }
  }
}
