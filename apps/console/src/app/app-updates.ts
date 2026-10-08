import { DOCUMENT } from '@angular/common';
import {
  ApplicationRef,
  DestroyRef,
  EnvironmentProviders,
  Injectable,
  InjectionToken,
  computed,
  inject,
  provideAppInitializer,
  signal,
} from '@angular/core';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { PAGE_LOCATION, reloginUrlOf } from '@console/shared/api';
import { Sheet } from '@console/shared/ui';
import { TimeoutError, filter, firstValueFrom, timeout } from 'rxjs';
import { hasUnsavedField } from './unsaved-input';

/** How often an open, visible app asks for a new version; a start and every resume ask at once. */
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
/** How long an automatic activation waits for requests in flight before it leaves the update to the banner. */
export const QUIET_WAIT_MS = 3_000;
/**
 * One self-heal per window. A version that breaks again right after a heal is left as it is rather than reloaded in
 * a loop; the next heal is allowed once the window has passed.
 */
export const RECOVERY_GUARD_MS = 10 * 60_000;
/** `localStorage` key of the last self-heal's time (ms since the epoch). */
export const RECOVERY_GUARD_KEY = 'tc.sw-recovery.v1';

/** ngsw's own words when a file it fetched is not the one its manifest hashed. */
const HASH_MISMATCH = /hash mismatch/i;

/** The browser surface the update flow touches, behind a token so specs never clear or reload the test runner. */
export interface UpdatePlatform {
  /** Deletes every cache Angular's service worker owns (`ngsw:` prefix), its own bookkeeping included. */
  clearWorkerCaches(): Promise<void>;
  unregisterWorkers(): Promise<void>;
  reload(): void;
  now(): number;
  /** `null` where storage is unavailable; the self-heal then never runs, since its loop guard could not hold. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function storageOf(view: Window | null): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return view?.localStorage ?? null;
  } catch (error: unknown) {
    // Safari throws on access when storage is blocked.
    console.error('[updates] localStorage is unavailable', error);
    return null;
  }
}

export function browserUpdatePlatform(document: Document): UpdatePlatform {
  const view = document.defaultView;
  return {
    async clearWorkerCaches() {
      if (view === null || !('caches' in view)) {
        return;
      }
      const names = await view.caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('ngsw:')).map((name) => view.caches.delete(name)),
      );
    },
    async unregisterWorkers() {
      if (view === null || !('serviceWorker' in view.navigator)) {
        return;
      }
      const registrations = await view.navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    },
    reload: () => document.location.reload(),
    now: () => Date.now(),
    storage: storageOf(view),
  };
}

export const UPDATE_PLATFORM = new InjectionToken<UpdatePlatform>('UPDATE_PLATFORM', {
  providedIn: 'root',
  factory: () => browserUpdatePlatform(inject(DOCUMENT)),
});

/** A start or a resume: the owner has not begun anything yet, so a quiet page may reload at once. */
type CheckTrigger = 'start' | 'resume' | 'interval';

/**
 * Brings each deploy to an installed PWA that is rarely closed (#306). Angular's service worker downloads a new
 * version in the background but only hands it to a fresh page, and an iPhone Home Screen app mostly resumes.
 *
 * - Asks for a new version on start, on every return to the foreground and every few minutes while visible.
 * - A version found by a start or resume check is switched to at once when nothing would be lost (no sheet open, no
 *   typed text, no request in flight); otherwise, and for one found while the app is in use, `ready()` turns on the
 *   «Обновить» banner. A pending update is also taken on the next resume when the page is quiet.
 * - A broken service worker (`unrecoverable`, or a hash mismatch installing a version) is healed without the owner
 *   clearing storage: its caches go, it is unregistered, and the page loads once past it (`ngsw-bypass`, stripped
 *   again in `main.ts`), guarded so a still-broken deploy cannot reload in a loop.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly platform = inject(UPDATE_PLATFORM);
  private readonly location = inject(PAGE_LOCATION);
  private readonly document = inject(DOCUMENT);
  private readonly sheet = inject(Sheet);
  private readonly appRef = inject(ApplicationRef);
  private readonly destroyRef = inject(DestroyRef);

  private readonly isPending = signal(false);
  private readonly isActivating = signal(false);
  /** Start or resume checks in flight: a VERSION_READY they cause is decided when they return, not shown at once. */
  private quietChecks = 0;
  /** A VERSION_READY arrived that neither the banner nor an activation has taken yet. */
  private hasDownloaded = false;
  private isRecovering = false;
  private isStarted = false;

  /** A newer version is downloaded and waits for «Обновить». */
  readonly ready = computed(() => this.isPending() && !this.isActivating());

  /** Wires the checks; a no-op without an enabled service worker (development builds, unsupported browsers). */
  start(): void {
    const updates = this.updates;
    if (this.isStarted || updates === null || !updates.isEnabled) {
      return;
    }
    this.isStarted = true;
    const versions = updates.versionUpdates.subscribe((event) => this.onVersionEvent(event));
    const broken = updates.unrecoverable.subscribe((event) => void this.recover(event.reason));
    const onVisibility = (): void => {
      if (this.isVisible()) {
        void this.resume();
      }
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => {
      if (this.isVisible()) {
        void this.check('interval');
      }
    }, UPDATE_CHECK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => {
      versions.unsubscribe();
      broken.unsubscribe();
      this.document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    });
    void this.check('start');
  }

  /** «Обновить»: switches this page to the downloaded version and loads it. */
  async activate(): Promise<void> {
    if (this.isActivating()) {
      return;
    }
    this.isActivating.set(true);
    try {
      await this.updates?.activateUpdate();
    } catch (error: unknown) {
      // The reload still gets the newest downloaded version: ngsw hands it to every new page.
      console.error('[updates] activateUpdate failed; reloading anyway', error);
    }
    this.platform.reload();
  }

  private isVisible(): boolean {
    return this.document.visibilityState === 'visible';
  }

  private onVersionEvent(event: VersionEvent): void {
    if (event.type === 'VERSION_READY') {
      this.hasDownloaded = true;
      if (this.quietChecks === 0) {
        this.isPending.set(true);
      }
    } else if (event.type === 'VERSION_INSTALLATION_FAILED') {
      if (HASH_MISMATCH.test(event.error)) {
        void this.recover(event.error);
      } else {
        console.error('[updates] a new version failed to install', event.error);
      }
    }
  }

  private async resume(): Promise<void> {
    if (this.isPending()) {
      await this.activateIfQuiet();
      return;
    }
    await this.check('resume');
  }

  private async check(trigger: CheckTrigger): Promise<void> {
    const updates = this.updates;
    if (updates === null || this.isActivating() || this.isRecovering) {
      return;
    }
    const isQuietTrigger = trigger !== 'interval';
    if (isQuietTrigger) {
      this.quietChecks += 1;
    }
    try {
      await updates.checkForUpdate();
    } catch (error: unknown) {
      console.error(`[updates] the ${trigger} check failed`, error);
    } finally {
      if (isQuietTrigger) {
        this.quietChecks -= 1;
      }
    }
    if (isQuietTrigger && this.quietChecks === 0 && this.hasDownloaded && !this.isPending()) {
      if (!(await this.activateIfQuiet())) {
        this.isPending.set(true);
      }
    }
  }

  private async activateIfQuiet(): Promise<boolean> {
    if (this.isActivating() || !(await this.isQuiet())) {
      return false;
    }
    await this.activate();
    return true;
  }

  private async isQuiet(): Promise<boolean> {
    if (this.hasUnsavedInput()) {
      return false;
    }
    return (await this.requestsSettle()) && !this.hasUnsavedInput();
  }

  private hasUnsavedInput(): boolean {
    return this.sheet.hasOpen() || hasUnsavedField(this.document);
  }

  /** The app is stable once no request or navigation is pending. */
  private async requestsSettle(): Promise<boolean> {
    try {
      await firstValueFrom(this.appRef.isStable.pipe(filter(Boolean), timeout(QUIET_WAIT_MS)));
      return true;
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        return false;
      }
      throw error;
    }
  }

  private async recover(reason: string): Promise<void> {
    if (this.isRecovering) {
      return;
    }
    if (!this.claimRecovery()) {
      console.error(
        '[updates] the service worker is broken again within the guard window; not reloading',
        reason,
      );
      return;
    }
    this.isRecovering = true;
    console.error('[updates] the service worker is broken; clearing it and reloading', reason);
    try {
      await this.platform.clearWorkerCaches();
    } catch (error: unknown) {
      console.error('[updates] clearing the service worker caches failed', error);
    }
    try {
      await this.platform.unregisterWorkers();
    } catch (error: unknown) {
      console.error('[updates] unregistering the service worker failed', error);
    }
    this.location.assign(reloginUrlOf(this.location.href));
  }

  /** Records this heal unless another one happened within the window; `false` means do not heal. */
  private claimRecovery(): boolean {
    const storage = this.platform.storage;
    if (storage === null) {
      return false;
    }
    try {
      const now = this.platform.now();
      const last = Number(storage.getItem(RECOVERY_GUARD_KEY) ?? '');
      if (Number.isFinite(last) && last > 0 && Math.abs(now - last) < RECOVERY_GUARD_MS) {
        return false;
      }
      storage.setItem(RECOVERY_GUARD_KEY, String(now));
      return true;
    } catch (error: unknown) {
      console.error('[updates] the self-heal guard could not be read or written', error);
      return false;
    }
  }
}

/** Starts `AppUpdates` with the app; place after `provideServiceWorker`. */
export function provideAppUpdates(): EnvironmentProviders {
  return provideAppInitializer(() => inject(AppUpdates).start());
}
