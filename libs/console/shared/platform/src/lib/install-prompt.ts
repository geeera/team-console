import { computed, DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { installPathOf } from './install-path';
import { Platform } from './platform';

/** Chromium's install event (not in lib.dom): `prompt()` opens the native dialog once per event. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

export function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  const candidate = event as Partial<BeforeInstallPromptEvent>;
  return typeof candidate.prompt === 'function' && candidate.userChoice instanceof Promise;
}

/** `failed`: no kept event, or `prompt()` threw; the browser menu is the way left. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'failed';

/**
 * The install event and `appinstalled` as the page saw them, from before Angular started: Chromium can fire
 * `beforeinstallprompt` early, and an event nobody `preventDefault()`s becomes Chrome's own mini-infobar.
 */
export class InstallPromptCapture {
  private kept: BeforeInstallPromptEvent | null = null;
  private installed = false;
  private readonly listeners = new Set<() => void>();

  constructor(view: Pick<Window, 'addEventListener'> | null) {
    view?.addEventListener('beforeinstallprompt', (event: Event) => {
      if (!isBeforeInstallPromptEvent(event)) {
        return;
      }
      event.preventDefault();
      this.kept = event;
      this.notify();
    });
    view?.addEventListener('appinstalled', () => this.markInstalled());
  }

  get event(): BeforeInstallPromptEvent | null {
    return this.kept;
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  /** `prompt()` works once per event; Chrome fires a new one when installing is possible again. */
  spend(): void {
    this.kept = null;
    this.notify();
  }

  markInstalled(): void {
    this.installed = true;
    this.kept = null;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let captured: InstallPromptCapture | null = null;

/** Called from `main.ts` before bootstrap; a second call keeps the first capture. */
export function captureInstallPrompt(view: Pick<Window, 'addEventListener'>): InstallPromptCapture {
  captured ??= new InstallPromptCapture(view);
  return captured;
}

/** The capture `main.ts` made; specs provide their own. */
export const INSTALL_PROMPT_CAPTURE = new InjectionToken<InstallPromptCapture>('INSTALL_PROMPT_CAPTURE', {
  providedIn: 'root',
  factory: () => captured ?? new InstallPromptCapture(null),
});

/** This launch's way to install, and the one-tap prompt where Chromium offers it. */
@Injectable({ providedIn: 'root' })
export class InstallPrompt {
  private readonly capture = inject(INSTALL_PROMPT_CAPTURE);
  private readonly platformSignals = inject(Platform).signals;

  private readonly event = signal(this.capture.event);
  readonly installedNow = signal(this.capture.isInstalled);
  /** The native dialog is open. */
  readonly isPrompting = signal(false);
  readonly hasEvent = computed(() => this.event() !== null);
  readonly path = computed(() =>
    installPathOf(this.platformSignals, { hasEvent: this.hasEvent(), installedNow: this.installedNow() }),
  );

  constructor() {
    const unsubscribe = this.capture.subscribe(() => {
      this.event.set(this.capture.event);
      this.installedNow.set(this.capture.isInstalled);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  async prompt(): Promise<InstallOutcome> {
    const event = this.capture.event;
    if (event === null || this.isPrompting()) {
      return 'failed';
    }
    this.isPrompting.set(true);
    try {
      await event.prompt();
    } catch (error: unknown) {
      // Not spent: the event stays kept, so a second tap may still open the dialog.
      console.warn('install: the install dialog did not open', error);
      this.isPrompting.set(false);
      return 'failed';
    }
    try {
      const { outcome } = await event.userChoice;
      if (outcome === 'accepted') {
        this.capture.markInstalled();
      } else {
        this.capture.spend();
      }
      return outcome;
    } catch (error: unknown) {
      console.warn('install: no answer from the install dialog', error);
      this.capture.spend();
      return 'failed';
    } finally {
      this.isPrompting.set(false);
    }
  }
}
