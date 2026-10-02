import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatusCardTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * A Settings block that states how one connection stands on this device or account (#24 GitHub, #36 notifications):
 * a round mark, a serif title, a body, and the block's actions. The tone colours the mark and the edge and always
 * repeats what the title says. The caller owns the heading element (level and focus); the parts are attributes.
 * `loading` shows the skeleton row with `loadingLabel` for screen readers instead of the content.
 *
 * ```html
 * <div tc-status-card tone="success">
 *   <div tc-status-card-row>
 *     <span tc-status-card-mark aria-hidden="true"><tc-icon name="check" size="sm" /></span>
 *     <div tc-status-card-who>
 *       <h3 tc-status-card-title tabindex="-1">Connected as geeera</h3>
 *       <p tc-status-card-meta>Since 2 October</p>
 *     </div>
 *   </div>
 *   <p tc-status-card-body>…</p>
 *   <div tc-status-card-actions><button tc-button type="button">Disconnect</button></div>
 * </div>
 * ```
 */
@Component({
  selector: '[tc-status-card]',
  template: `
    @if (loading()) {
      <span class="tc-sr-only">{{ loadingLabel() }}</span>
      <span class="tc-status-card__skeleton" aria-hidden="true">
        <span class="tc-status-card__skeleton-mark"></span>
        <span class="tc-status-card__skeleton-line"></span>
      </span>
    } @else {
      <ng-content />
    }
  `,
  styleUrl: './status-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-status-card',
    '[class.tc-status-card--success]': 'tone() === "success"',
    '[class.tc-status-card--warning]': 'tone() === "warning"',
    '[class.tc-status-card--danger]': 'tone() === "danger"',
    '[attr.aria-busy]': 'loading() ? "true" : null',
  },
})
export class StatusCard {
  readonly tone = input<StatusCardTone>('neutral');
  readonly loading = input(false, { transform: booleanAttribute });
  /** Already translated: what is being checked, for screen readers while `loading`. */
  readonly loadingLabel = input('');
}
