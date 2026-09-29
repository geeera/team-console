import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon, IconName } from '../icon/icon';

export type CardStamp = 'positive' | 'negative' | 'neutral';

const STAMP_GLYPH: Record<CardStamp, IconName> = {
  positive: 'check',
  negative: 'x',
  neutral: 'minus',
};

/**
 * A paper card: kind and number on top, a serif title, body, then actions and meta in the foot.
 * `stamp` presses the ink stamp onto it — the signature moment when a decision is answered
 * (ADR 0002); under reduced motion it simply appears.
 *
 * ```html
 * <tc-card [stamp]="answered() ? 'positive' : null">
 *   <span tc-card-kind>Question</span>
 *   <span tc-card-number>#13</span>
 *   <h3 tc-card-title>Ship the design kit?</h3>
 *   <p>Body text…</p>
 *   <button tc-button tc-card-action variant="primary">Approve</button>
 *   <span tc-card-meta>2 h ago</span>
 * </tc-card>
 * ```
 */
@Component({
  selector: 'tc-card',
  imports: [Icon],
  templateUrl: './card.html',
  styleUrl: './card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-card',
    '[class.tc-card--stamped]': 'stamp() !== null',
    '[class.tc-card--negative]': 'stamp() === "negative"',
    '[class.tc-card--neutral]': 'stamp() === "neutral"',
    '[class.tc-card--flush]': 'flush()',
  },
})
export class Card {
  readonly stamp = input<CardStamp | null>(null);
  /** No margin indent; the phone layout and lists use this. */
  readonly flush = input(false, { transform: booleanAttribute });

  protected readonly stampGlyph = computed<IconName | null>(() => {
    const stamp = this.stamp();
    return stamp === null ? null : STAMP_GLYPH[stamp];
  });
}
