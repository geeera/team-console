import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { Chip } from '../chip/chip';
import { Roll } from '../roll/roll';

/**
 * The accent count pill beside a list row's title («Needs you», a project's waiting items). The caller keeps the
 * badge in the template whatever the count: a count change rolls the number (`tc-roll`), and when it reaches 0 the
 * pill shrinks into a dot and leaves, after the number has rolled to 0. Under reduced motion the number changes at
 * once and the pill fades out through `opacity`. A badge whose count starts at 0 renders nothing, and the row's
 * trailing slot closes up.
 *
 * `text` is the count as the owner reads it (formatted by the caller), `label` the full name for assistive tech
 * ("Waiting for you: 2"); the visible number is hidden from it so nothing is read twice.
 *
 * ```html
 * <tc-count-badge tc-row-trailing [count]="total" [text]="total | localNumber" [label]="'…' | transloco: { n: total }" />
 * ```
 */
@Component({
  selector: 'tc-count-badge',
  imports: [Chip, Roll],
  template: `
    @if (rendered()) {
      <tc-chip
        class="tc-count-badge__pill"
        tone="accent"
        [class.tc-count-badge__pill--leaving]="leaving()"
        [attr.aria-hidden]="leaving() ? 'true' : null"
        (animationend)="onAnimationEnd($event)"
      >
        <tc-roll aria-hidden="true" [value]="text()" />
        <span class="tc-sr-only">{{ label() }}</span>
      </tc-chip>
    }
  `,
  styleUrl: './count-badge.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-count-badge', '[hidden]': '!rendered()' },
})
export class CountBadge {
  readonly count = input.required<number>();
  readonly text = input.required<string>();
  readonly label = input.required<string>();

  /** True once the exit has played (or the badge never had a count), so a 0 is not drawn. */
  private readonly gone = signal(true);

  protected readonly leaving = computed(() => this.count() <= 0 && !this.gone());
  protected readonly rendered = computed(() => this.count() > 0 || !this.gone());

  constructor() {
    effect(() => {
      if (this.count() > 0) {
        this.gone.set(false);
      }
    });
  }

  protected onAnimationEnd(event: AnimationEvent): void {
    // The rolling number's own animations bubble up here; only the pill's exit ends the badge.
    if (event.target === event.currentTarget && this.leaving()) {
      this.gone.set(true);
    }
  }
}
