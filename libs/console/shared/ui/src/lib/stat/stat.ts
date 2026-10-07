import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { Icon } from '../icon/icon';

export type StatTone = 'neutral' | 'success' | 'danger';

/**
 * Numbers at a glance, as a description list: `<dl tc-stats>` holding `<div tc-stat>` groups (the only children a
 * `dl` may have besides `dt`/`dd`). As many equal columns as fit (two on the phone), dropping a column rather than
 * squeezing a label onto a second line.
 *
 * ```html
 * <dl tc-stats>
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
  host: { class: 'tc-stats' },
})
export class Stats {}

/**
 * One number: the label as `dt`, the projected value as `dd`, an optional `sub` line under it. Label, value and sub
 * line never wrap: a value too long for the tile ends in an ellipsis, so it must also be in `actionLabel` (or
 * readable elsewhere). The tone repeats what the value says, never alone.
 *
 * With `actionLabel` the value is a button that covers the whole tile (a ›, `(activate)` on a tap); `actionLabel`
 * is its accessible name and should repeat the label and value ("CI: 1 PR failed. Open PRs").
 */
@Component({
  selector: 'div[tc-stat]',
  imports: [Icon, NgTemplateOutlet],
  template: `
    <ng-template #value><ng-content /></ng-template>
    <dt class="tc-stat__label">{{ label() }}</dt>
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
          <tc-icon class="tc-stat__chevron" name="chevron-right" size="sm" />
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
