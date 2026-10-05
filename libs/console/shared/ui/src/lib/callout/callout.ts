import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type CalloutTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * A note in the margin (Paper Desk): a rule on the left in the tone's colour, a serif title and a short body —
 * the outcome of a check, a "connect first" prompt. The tone repeats what the title says; it never says it alone.
 * The caller owns the heading element (its level, id and focus).
 *
 * ```html
 * <section tc-callout tone="danger" aria-labelledby="result">
 *   <h2 tc-callout-title id="result" tabindex="-1">Project not added</h2>
 *   <p>Nothing was saved.</p>
 * </section>
 * ```
 */
@Component({
  selector: '[tc-callout]',
  template: '<ng-content />',
  styleUrl: './callout.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-callout',
    '[class.tc-callout--success]': 'tone() === "success"',
    '[class.tc-callout--warning]': 'tone() === "warning"',
    '[class.tc-callout--danger]': 'tone() === "danger"',
  },
})
export class Callout {
  readonly tone = input<CalloutTone>('neutral');
}
