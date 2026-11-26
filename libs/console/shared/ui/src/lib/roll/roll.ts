import { ChangeDetectionStrategy, Component, effect, input, signal, untracked } from '@angular/core';

/**
 * A number (or short text) that rolls to its new value: the old one leaves upward while the new one comes up from
 * below, inside the line's own height. Nothing rolls on the first render, so a board that opens on its counts shows
 * them still. The old value is hidden from assistive tech and the box always holds the current text alone, so reading
 * order and the accessible name never see two values. Under reduced motion the value is swapped at once.
 *
 * ```html
 * <tc-roll [value]="count()" />
 * ```
 */
@Component({
  selector: 'tc-roll',
  template: `
    @for (step of steps(); track step) {
      @if (previous(); as old) {
        <span class="tc-roll__out" aria-hidden="true">{{ old }}</span>
      }
      <span
        class="tc-roll__in"
        [class.tc-roll__in--rolling]="previous() !== null"
        (animationend)="settle()"
        >{{ text() }}</span
      >
    }
  `,
  styleUrl: './roll.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-roll' },
})
export class Roll {
  readonly value = input.required<string | number>();

  protected readonly text = signal('');
  protected readonly previous = signal<string | null>(null);
  // One element pair per change, so a value changing mid-roll restarts the motion instead of skipping it.
  protected readonly steps = signal<readonly number[]>([0]);

  constructor() {
    effect(() => {
      const next = String(this.value());
      untracked(() => {
        const current = this.text();
        this.text.set(next);
        if (current !== '' && current !== next) {
          this.previous.set(current);
          this.steps.update(([step = 0]) => [step + 1]);
        }
      });
    });
  }

  protected settle(): void {
    this.previous.set(null);
  }
}
