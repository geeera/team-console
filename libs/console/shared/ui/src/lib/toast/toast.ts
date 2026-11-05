import { ChangeDetectionStrategy, Component, DestroyRef, inject, Injectable, signal } from '@angular/core';

/** Long enough to read a short sentence twice; the message stays in the live region's history either way. */
export const TOAST_DURATION_MS = 4000;

/** How long Undo stays offered (#409 §5): `--undo-ms` in tokens.css is the same 10 s for its hairline. */
export const UNDO_DURATION_MS = 10_000;

/** Undo on the toast (#409's Undo slip): its label and what it does. */
export interface ToastUndo {
  /** Already translated, e.g. «Отменить». */
  readonly label: string;
  readonly run: () => void;
}

/**
 * One short confirmation at a time ("storify archived"). The text is announced through the outlet's
 * `role=status` region, which exists before any message so screen readers pick the change up. `offerUndo` (#409)
 * adds an Undo button for `UNDO_DURATION_MS`, paused while the pointer or focus is on the toast; ⌘Z / Ctrl+Z
 * undoes while it is up.
 */
@Injectable({ providedIn: 'root' })
export class Toaster {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remainingMs = 0;
  private startedAt = 0;

  readonly message = signal<string | null>(null);
  readonly undo = signal<ToastUndo | null>(null);

  /** Already translated. A new message replaces the current one and restarts the timer. */
  show(message: string): void {
    this.open(message, null, TOAST_DURATION_MS);
  }

  /** Already translated. The undo is offered once: running it (or the next message) ends the offer. */
  offerUndo(message: string, undo: ToastUndo): void {
    this.open(message, undo, UNDO_DURATION_MS);
  }

  /** Runs the offered undo, if one is up; `true` when it ran. */
  runUndo(): boolean {
    const undo = this.undo();
    if (undo === null) {
      return false;
    }
    this.dismiss();
    undo.run();
    return true;
  }

  /** Hover or focus on the toast: the clock stops until it leaves. */
  pause(): void {
    if (this.timer === null) {
      return;
    }
    this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
    this.clearTimer();
  }

  resume(): void {
    if (this.timer !== null || this.message() === null) {
      return;
    }
    this.startTimer(this.remainingMs);
  }

  dismiss(): void {
    this.clearTimer();
    this.message.set(null);
    this.undo.set(null);
  }

  private open(message: string, undo: ToastUndo | null, durationMs: number): void {
    this.clearTimer();
    this.message.set(message);
    this.undo.set(undo);
    this.startTimer(durationMs);
  }

  private startTimer(durationMs: number): void {
    this.remainingMs = durationMs;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.dismiss(), durationMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

/** Where `Toaster` messages appear: placed once by the app shell, above the content and the safe area. */
@Component({
  selector: 'tc-toast-outlet',
  template: `
    @if (toaster.message(); as message) {
      @if (toaster.undo(); as undo) {
        <div
          class="tc-toast tc-toast--undo"
          data-testid="undo-toast"
          (mouseenter)="toaster.pause()"
          (mouseleave)="toaster.resume()"
          (focusin)="toaster.pause()"
          (focusout)="toaster.resume()"
        >
          <span class="tc-toast__message">{{ message }}</span>
          <button
            type="button"
            class="tc-toast__undo"
            data-testid="undo"
            aria-keyshortcuts="Meta+Z Control+Z"
            (click)="toaster.runUndo()"
          >
            {{ undo.label }}<kbd class="tc-toast__kbd" aria-hidden="true">⌘Z</kbd>
          </button>
          <span class="tc-toast__bar" aria-hidden="true"></span>
        </div>
      } @else {
        <p class="tc-toast">{{ message }}</p>
      }
    }
  `,
  styleUrl: './toast.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-toast-outlet',
    role: 'status',
    'aria-live': 'polite',
    '[class.tc-toast-outlet--action]': 'toaster.undo() !== null',
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class ToastOutlet {
  protected readonly toaster = inject(Toaster);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.toaster.dismiss());
  }

  /** ⌘Z / Ctrl+Z undoes the offered change, but never steals a text field's own undo. */
  protected onKeydown(event: KeyboardEvent): void {
    if (
      event.key.toLowerCase() !== 'z' ||
      !(event.metaKey || event.ctrlKey) ||
      event.shiftKey ||
      event.altKey ||
      isTextField(event.target) ||
      this.toaster.undo() === null
    ) {
      return;
    }
    event.preventDefault();
    this.toaster.runUndo();
  }
}
