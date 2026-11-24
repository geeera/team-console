import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  InjectionToken,
  input,
  signal,
} from '@angular/core';
import { DEMO_LEAF_KEY, isDemoLeafSeen, tornLeafOf, type DemoLeafSeen } from './demo-leaf-memory';

/** The storage seam; tests supply an in-memory one. Device-local only, never sent to the Worker. */
export interface DemoLeafStorage {
  read(): string | null;
  /** May throw (quota, private mode); the leaf keeps working without remembering. */
  write(value: string): void;
}

export const DEMO_LEAF_STORAGE = new InjectionToken<DemoLeafStorage>('DEMO_LEAF_STORAGE', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return {
      read: () => {
        try {
          return view?.localStorage.getItem(DEMO_LEAF_KEY) ?? null;
        } catch {
          // Storage disabled: behave like a first visit.
          return null;
        }
      },
      write: (value) => view?.localStorage.setItem(DEMO_LEAF_KEY, value),
    };
  },
});

/** Once per page session, whatever number of boards open (#363). */
let hasTornThisSession = false;

/** Test hook: a new session. */
export function resetDemoLeafSession(): void {
  hasTornThisSession = false;
}

/**
 * The board header's tear-off calendar leaf (#363): «Демо · через 3 дня», and on the day itself an accent leaf. When a
 * day has turned since the owner last looked, the old leaf tears upward once per session and shows the new one under
 * it; under reduced motion the leaf just shows today's words.
 */
@Component({
  selector: 'tc-demo-leaf',
  template: `{{ line() }}`,
  styleUrl: './demo-leaf.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-demo-leaf',
    '[class.tc-demo-leaf--today]': 'days() === 0',
    '[class.tc-demo-leaf--tearing]': 'tornLine() !== null',
    '[attr.data-torn]': 'tornLine()',
    '(animationend)': 'onAnimationEnd($event)',
  },
})
export class DemoLeaf {
  /** The demo's day, as the board knows it. */
  readonly due = input.required<string>();
  /** Whole days until the demo; 0 on the day, negative after. */
  readonly days = input.required<number>();
  /** The leaf's words, already translated. */
  readonly line = input.required<string>();

  private readonly storage = inject(DEMO_LEAF_STORAGE);
  private readonly document = inject(DOCUMENT);
  /** The words of the leaf being torn away; `null` when nothing tears. */
  protected readonly tornLine = signal<string | null>(null);

  constructor() {
    afterNextRender(() => this.settleAfterFirstRead());
  }

  protected onAnimationEnd(event: AnimationEvent): void {
    if (event.animationName === 'tc-leaf-tear') {
      this.tornLine.set(null);
    }
  }

  /** Reads inputs once they are set, plans a tear if a day turned, and remembers what is shown now. */
  private settleAfterFirstRead(): void {
    const now: DemoLeafSeen = { due: this.due(), days: this.days(), line: this.line() };
    const torn = tornLeafOf(this.readSeen(), now, !hasTornThisSession && !this.prefersReducedMotion());
    if (torn !== null) {
      hasTornThisSession = true;
      this.tornLine.set(torn);
    }
    try {
      this.storage.write(JSON.stringify(now));
    } catch {
      // Private mode, full quota or blocked storage: the leaf is simply not remembered for next time.
    }
  }

  /** The OS setting, unless `<html data-motion>` says otherwise (the same switch as the token blocks). */
  private prefersReducedMotion(): boolean {
    const view = this.document.defaultView;
    const forced = this.document.documentElement.dataset['motion'];
    if (forced === 'reduce') {
      return true;
    }
    return forced !== 'full' && (view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  }

  private readSeen(): DemoLeafSeen | null {
    const raw = this.storage.read();
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isDemoLeafSeen(parsed) ? parsed : null;
    } catch {
      // A damaged value is the same as never having seen the leaf.
      return null;
    }
  }
}
