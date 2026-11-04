import { inject, Injectable } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { TranslocoService } from '@console/shared/i18n';

/**
 * The `env.*` copy (#104) ships in its own lazy chunks, not in the inline Russian catalogue: the initial bundle has no
 * room for it (#337). Both languages are merged into Transloco before the first screen that uses them renders, so a
 * language switch there needs no further load and no key ever shows raw.
 */
@Injectable({ providedIn: 'root' })
export class EnvironmentCopy {
  private readonly transloco = inject(TranslocoService);
  private pending: Promise<void> | null = null;

  ready(): Promise<void> {
    this.pending ??= this.load();
    return this.pending;
  }

  private async load(): Promise<void> {
    try {
      const [ru, en] = await Promise.all([import('./copy/ru.json'), import('./copy/en.json')]);
      this.transloco.setTranslation({ env: ru.default }, 'ru', { merge: true, emitChange: true });
      this.transloco.setTranslation({ env: en.default }, 'en', { merge: true, emitChange: true });
    } catch (error: unknown) {
      // A chunk that cannot load (offline before the service worker cached it): the screen still opens, and the
      // next navigation tries again.
      console.warn('environment copy could not load', error);
      this.pending = null;
    }
  }
}

/** Route guard: the screen waits for its copy, never for the network status call. */
export const environmentCopyReady: CanActivateFn = async () => {
  await inject(EnvironmentCopy).ready();
  return true;
};
