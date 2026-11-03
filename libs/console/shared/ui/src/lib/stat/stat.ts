import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Icon, IconName } from '../icon/icon';

export type StatTone = 'neutral' | 'success' | 'danger';

/**
 * Numbers at a glance, as a description list: `<dl tc-stats>` holding `<div tc-stat>` groups (the only children a
 * `dl` may have besides `dt`/`dd`). By default as many equal columns as fit (two on the phone), dropping a column
 * rather than squeezing a label onto a second line; `columns` fixes the count when the caller knows its width
 * (so five tiles never leave one alone on a second row).
 *
 * ```html
 * <dl tc-stats [columns]="4">
 *   <div tc-stat label="Done">3 of 9</div>
 *   <div tc-stat label="Open PRs">2</div>
 * </dl>
 * ```
 */
@Component({
  selector: 'dl[tc-stats]',
  template: '<ng-content />',
  styleUrl: './stats.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-stats', '[style.grid-template-columns]': 'template()' },
})
export class Stats {
  /** A fixed number of equal columns; `null` lets them fit the width. */
  readonly columns = input<number | null>(null);

  protected readonly template = computed(() => {
    const columns = this.columns();
    return columns === null || !Number.isSafeInteger(columns) || columns < 1
      ? null
      : `repeat(${columns}, minmax(0, 1fr))`;
  });
}

/**
 * One number: the label as `dt`, the projected value as `dd`, an optional `sub` line under it. Label, value and sub
 * line never wrap; a narrow tile sets its value a step smaller (a container query on the tile), and only a value that
 * still does not fit ends in an ellipsis, so it must also be in `actionLabel` (or readable elsewhere). The tone
 * repeats what the value says, never alone.
 *
 * `icon` sits before the label, so the whole width of the tile goes to the value (#275: «1 PR не прошёл» at 390 px).
 * With `actionLabel` the value is a button that covers the whole tile, with a › at the end of the label row and
 * `(activate)` on a tap; `actionLabel` is its accessible name and should repeat the label and value
 * ("CI: 1 PR failed. Open PRs").
 */
@Component({
  selector: 'div[tc-stat]',
  imports: [Icon, NgTemplateOutlet],
  template: `
    <ng-template #value><ng-content /></ng-template>
    <dt class="tc-stat__label">
      @if (icon(); as icon) {
        <tc-icon class="tc-stat__icon" [name]="icon" size="sm" />
      }
      <span class="tc-stat__label-text">{{ label() }}</span>
      @if (actionLabel() !== null) {
        <tc-icon class="tc-stat__chevron" name="chevron-right" size="sm" />
      }
    </dt>
    <dd class="tc-stat__value">
      @if (actionLabel(); as name) {
        <button
          #action
          type="button"
          class="tc-stat__action"
          [attr.aria-label]="name"
          (click)="activate.emit()"
        >
          <span class="tc-stat__text"><ng-container [ngTemplateOutlet]="value" /></span>
        </button>
      } @else {
        <span class="tc-stat__text"><ng-container [ngTemplateOutlet]="value" /></span>
      }
      @if (sub(); as sub) {
        <span class="tc-stat__sub">{{ sub }}</span>
      }
    </dd>
  `,
  styleUrl: './stat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-stat',
    '[class.tc-stat--success]': 'tone() === "success"',
    '[class.tc-stat--danger]': 'tone() === "danger"',
    '[class.tc-stat--action]': 'actionLabel() !== null',
  },
})
export class Stat {
  readonly label = input.required<string>();
  readonly tone = input<StatTone>('neutral');
  /** A glyph before the label that says the state without colour (✗, ✓, ▷); coloured by the tone. */
  readonly icon = input<IconName | null>(null);
  /** A second, quieter line under the value ("3 still open"). */
  readonly sub = input<string | null>(null);
  /** Makes the tile a button with this accessible name; `null` keeps it plain. */
  readonly actionLabel = input<string | null>(null);
  readonly activate = output<void>();

  private readonly action = viewChild<ElementRef<HTMLButtonElement>>('action');

  /** Focus the tile's button, e.g. to return focus to it; a plain tile has nothing to focus. */
  focus(): void {
    this.action()?.nativeElement.focus();
  }
}
