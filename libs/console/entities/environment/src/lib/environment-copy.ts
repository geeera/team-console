import { ErrorHandler, inject, Injectable, InjectionToken, signal } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { TranslocoService } from '@console/shared/i18n';

export interface EnvironmentCopyChunks {
  readonly ru: Record<string, unknown>;
  readonly en: Record<string, unknown>;
}

/** The `env.*` copy from its own lazy chunks. */
export async function loadEnvironmentCopyChunks(): Promise<EnvironmentCopyChunks> {
  const [ru, en] = await Promise.all([import('./copy/ru.json'), import('./copy/en.json')]);
  return { ru: ru.default, en: en.default };
}

/** Where the `env.*` copy comes from; a seam for specs, which make it fail. */
export const ENVIRONMENT_COPY_LOADER = new InjectionToken<() => Promise<EnvironmentCopyChunks>>(
  'ENVIRONMENT_COPY_LOADER',
  { providedIn: 'root', factory: () => loadEnvironmentCopyChunks },
);

/**
 * The `env.*` copy (#104) ships in its own lazy chunks, not in the inline Russian catalogue: the initial bundle has no
 * room for it (#337). Both languages are merged into Transloco before the first screen that uses them renders, so a
 * language switch there needs no further load. When the chunks cannot load (offline before the service worker
 * cached them), `failed()` is set and the error reported; the screens then show a readable error from the inline
 * catalogue with Try again — never a raw `env.*` key.
 */
@Injectable({ providedIn: 'root' })
export class EnvironmentCopy {
  private readonly transloco = inject(TranslocoService);
  private readonly errors = inject(ErrorHandler);
  private readonly loader = inject(ENVIRONMENT_COPY_LOADER);
  private pending: Promise<boolean> | null = null;

  readonly loaded = signal(false);
  readonly failed = signal(false);

  /** Resolves `true` once the copy is merged, `false` when it could not load (a later call tries again). */
  ready(): Promise<boolean> {
    this.pending ??= this.load();
    return this.pending;
  }

  private async load(): Promise<boolean> {
    try {
      const { ru, en } = await this.loader();
      this.transloco.setTranslation({ env: ru }, 'ru', { merge: true, emitChange: true });
      this.transloco.setTranslation({ env: en }, 'en', { merge: true, emitChange: true });
      this.failed.set(false);
      this.loaded.set(true);
      return true;
    } catch (error: unknown) {
      this.errors.handleError(error);
      this.failed.set(true);
      this.pending = null;
      return false;
    }
  }
}

/**
 * Route guard: the screen waits for its copy, never for the network status call. It lets the navigation through
 * either way — Settings must open without it, and the screens show their own error state when `failed()`.
 */
export const environmentCopyReady: CanActivateFn = async () => {
  await inject(EnvironmentCopy).ready();
  return true;
};
