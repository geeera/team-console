import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatTone = 'neutral' | 'success' | 'danger';

/**
 * Numbers at a glance, as a description list: `<dl tc-stats>` holding `<div tc-stat>` groups (the only children a
 * `dl` may have besides `dt`/`dd`). Two columns on the phone, as many as fit on wider screens.
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

/** One number: the label as `dt`, the projected value as `dd`. The tone repeats what the value says, never alone. */
@Component({
  selector: 'div[tc-stat]',
  template: `
    <dt class="tc-stat__label">{{ label() }}</dt>
    <dd class="tc-stat__value"><ng-content /></dd>
  `,
  styleUrl: './stat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-stat',
    '[class.tc-stat--success]': 'tone() === "success"',
    '[class.tc-stat--danger]': 'tone() === "danger"',
  },
})
export class Stat {
  readonly label = input.required<string>();
  readonly tone = input<StatTone>('neutral');
}
