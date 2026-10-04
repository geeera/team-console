import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CardStamp } from '../card/card';
import { Icon, IconName } from '../icon/icon';

/** The card stamps, plus `warning` for an outcome nobody can confirm yet (#114: the run service did not answer). */
export type ReceiptTone = CardStamp | 'warning';

const GLYPH: Record<ReceiptTone, IconName> = {
  positive: 'check',
  negative: 'x',
  neutral: 'minus',
  warning: 'question',
};

/**
 * The margin note a decision card folds into once it is answered (ADR 0002's signature moment): the owner's
 * verb, a detail and the meta line (`#72 · 14:05 · recorded as owner`). Focusable from code (`tabindex="-1"`)
 * so focus can land here when the card it replaces disappears.
 *
 * ```html
 * <tc-receipt tone="positive">
 *   <span tc-receipt-verb>You: approve</span>
 *   <span tc-receipt-detail>Plan for the demo</span>
 *   <span tc-receipt-meta>#72 · 14:05 · recorded as owner</span>
 * </tc-receipt>
 * ```
 */
@Component({
  selector: 'tc-receipt',
  imports: [Icon],
  template: `
    <span class="tc-receipt__icon"><tc-icon [name]="glyph()" size="sm" /></span>
    <span class="tc-receipt__body">
      <span class="tc-receipt__verb"><ng-content select="[tc-receipt-verb]" /></span>
      <span class="tc-receipt__detail"><ng-content select="[tc-receipt-detail]" /></span>
    </span>
    <span class="tc-receipt__meta"><ng-content select="[tc-receipt-meta]" /></span>
  `,
  styleUrl: './receipt.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-receipt',
    tabindex: '-1',
    '[class.tc-receipt--negative]': 'tone() === "negative"',
    '[class.tc-receipt--neutral]': 'tone() === "neutral"',
    '[class.tc-receipt--warning]': 'tone() === "warning"',
  },
})
export class Receipt {
  readonly tone = input<ReceiptTone>('positive');

  protected readonly glyph = computed(() => GLYPH[this.tone()]);
}
