import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  provideEnvironmentInitializer,
  signal,
  untracked,
  type EnvironmentProviders,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { AccessSession } from '@console/shared/api';
import { INSTALL_CARD_PATHS, InstallPrompt } from '@console/shared/platform';
import { InstallMemoryStore } from './install-memory';

/**
 * `landing` before the first screen decided · `awaiting-event` Chromium may still fire its install event ·
 * `armed` it fired after the landing screen rendered, so the card waits for the next screen · `shown` on one screen
 * · `over` for this launch (answered, left unanswered, or nothing to offer).
 */
type OfferPhase = 'landing' | 'awaiting-event' | 'armed' | 'shown' | 'over';

/** A screen is its path: a new query or fragment is the same screen. */
export function screenOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

/**
 * One install offer per launch (#761 UX spec §3): on the landing screen once it is ready, or, when Chromium's event
 * comes late, on the next screen opened, never inserted above a screen being read. Leaving the screen unanswered
 * ends it for this launch only. While the card has the launch, the push nudge waits (one prompt per launch).
 */
@Injectable({ providedIn: 'root' })
export class InstallOffer {
  private readonly prompt = inject(InstallPrompt);
  private readonly memory = inject(InstallMemoryStore);
  private readonly session = inject(AccessSession);

  private readonly phase = signal<OfferPhase>('landing');
  private readonly shownOn = signal<string | null>(null);
  private readonly tookLaunch = signal(false);
  private readonly armedOn = signal<string | null>(null);
  private readonly current = signal<string | null>(null);
  private screens = 0;

  /** The screen the app is on, from the router. */
  readonly screen = this.current.asReadonly();
  readonly isShownHere = computed(() => this.phase() === 'shown' && this.shownOn() === this.current());

  constructor() {
    const router = inject(Router);
    // Created after the first navigation (a spec, or no provideInstallOffer): the screen it is on is the landing one.
    if (router.navigated) {
      this.onScreen(screenOf(router.url));
    }
    const subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.onScreen(screenOf(event.urlAfterRedirects));
      }
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
    effect(() => {
      if (this.prompt.hasEvent()) {
        untracked(() => this.onLateEvent());
      }
    });
  }

  /**
   * Whether the push nudge waits on `screen`. A late event arms the card while a nudge may already be on the
   * landing screen: that one stays rather than vanish under the reader.
   */
  holdsPushNudgeOn(screen: string | null): boolean {
    return this.tookLaunch() && screen !== this.armedOn();
  }

  /** A screen hosting the card is ready; the first one to ask on the landing screen decides. */
  present(screen: string): void {
    if (this.current() === null) {
      this.onScreen(screen);
    }
    if (screen !== this.current()) {
      return;
    }
    switch (this.phase()) {
      case 'landing':
        this.decideLanding(screen);
        return;
      case 'armed':
        if (screen !== this.armedOn() && this.isOfferable()) {
          this.show(screen);
        }
        return;
      default:
        return;
    }
  }

  /** Not now, a dismissed native dialog, or Don't show again. */
  answer(choice: 'later' | 'never'): void {
    if (choice === 'never') {
      this.memory.never();
    } else {
      this.memory.snooze();
    }
    this.phase.set('over');
  }

  /** Accepted: the card turns into its success line until it is closed or the screen changes. */
  installed(): void {
    this.memory.clear();
  }

  close(): void {
    this.phase.set('over');
  }

  private decideLanding(screen: string): void {
    if (!this.memory.canOffer() || this.session.expired()) {
      this.phase.set('over');
      return;
    }
    const path = this.prompt.path();
    if (INSTALL_CARD_PATHS.includes(path)) {
      this.show(screen);
    } else if (path === 'menu') {
      this.phase.set('awaiting-event');
    } else {
      this.phase.set('over');
    }
  }

  private isOfferable(): boolean {
    return (
      this.memory.canOffer() && !this.session.expired() && INSTALL_CARD_PATHS.includes(this.prompt.path())
    );
  }

  private show(screen: string): void {
    this.phase.set('shown');
    this.shownOn.set(screen);
    this.tookLaunch.set(true);
    this.memory.markShown();
  }

  private onLateEvent(): void {
    if (this.phase() !== 'awaiting-event') {
      return;
    }
    this.armedOn.set(this.current());
    this.phase.set('armed');
    this.tookLaunch.set(true);
  }

  private onScreen(screen: string): void {
    if (screen === this.current()) {
      return;
    }
    this.screens += 1;
    this.current.set(screen);
    const phase = this.phase();
    if (phase === 'shown' || (phase === 'landing' && this.screens > 1)) {
      this.phase.set('over');
    }
  }
}

/** Starts counting screens with the app, so the landing screen is the first one the router reaches. */
export function provideInstallOffer(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    inject(InstallOffer);
  });
}
