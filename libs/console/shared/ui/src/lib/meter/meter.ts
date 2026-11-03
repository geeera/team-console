import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * A thin progress bar for a ratio the text next to it already states ("3 of 8 done"), so it is decorative:
 * `aria-hidden`, never the only carrier of the number. `max` 0 reads as empty, values outside 0…max are clamped.
 *
 * ```html
 * <tc-meter [value]="shipped" [max]="planned" />
 * ```
 */
@Component({
  selector: 'tc-meter',
  template: '<i class="tc-meter__fill" [style.inline-size.%]="percent()"></i>',
  styleUrl: './meter.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-meter', 'aria-hidden': 'true' },
})
export class Meter {
  readonly value = input.required<number>();
  readonly max = input.required<number>();

  protected readonly percent = computed(() => meterPercent(this.value(), this.max()));
}

/** `value / max` as a whole percentage in 0…100; 0 for an empty or invalid `max`. */
export function meterPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return Math.round((Math.min(Math.max(value, 0), max) / max) * 100);
}
