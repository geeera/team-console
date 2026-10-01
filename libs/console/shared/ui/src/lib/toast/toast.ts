import { ChangeDetectionStrategy, Component, DestroyRef, inject, Injectable, signal } from '@angular/core';

/** Long enough to read a short sentence twice; the message stays in the live region's history either way. */
export const TOAST_DURATION_MS = 4000;

/**
 * One short confirmation at a time ("storify archived"). The text is announced through the outlet's
 * `role=status` region, which exists before any message so screen readers pick the change up.
 */
@Injectable({ providedIn: 'root' })
export class Toaster {
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly message = signal<string | null>(null);

  /** Already translated. A new message replaces the current one and restarts the timer. */
  show(message: string): void {
    this.clearTimer();
    this.message.set(message);
    this.timer = setTimeout(() => this.dismiss(), TOAST_DURATION_MS);
  }

  dismiss(): void {
    this.clearTimer();
    this.message.set(null);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Where `Toaster` messages appear: placed once by the app shell, above the content and the safe area. */
@Component({
  selector: 'tc-toast-outlet',
  template: `
    @if (toaster.message(); as message) {
      <p class="tc-toast">{{ message }}</p>
    }
  `,
  styleUrl: './toast.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-toast-outlet', role: 'status', 'aria-live': 'polite' },
})
export class ToastOutlet {
  protected readonly toaster = inject(Toaster);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.toaster.dismiss());
  }
}
