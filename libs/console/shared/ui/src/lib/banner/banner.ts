import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type BannerTone = 'warning' | 'danger';

/**
 * A strip across a screen for a state that holds until someone acts (#114: the project is paused): words first,
 * then the one action. `warning` (ochre) when the owner chose it, `danger` (clay) when it happened on its own. The
 * caller decides whether it is a live region (`role="status"`) — a banner present on load should not be announced.
 *
 * ```html
 * <div tc-banner tone="warning">
 *   <tc-icon tc-banner-icon name="pause" />
 *   <p tc-banner-text><b>storify is paused since 13:52.</b> Scheduled runs exit at once.</p>
 *   <div tc-banner-actions><button tc-button size="sm" type="button">Resume</button></div>
 * </div>
 * ```
 */
@Component({
  selector: '[tc-banner]',
  template: `
    <ng-content select="[tc-banner-icon]" />
    <ng-content select="[tc-banner-text]" />
    <ng-content select="[tc-banner-actions]" />
  `,
  styleUrl: './banner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-banner',
    '[class.tc-banner--warning]': 'tone() === "warning"',
    '[class.tc-banner--danger]': 'tone() === "danger"',
  },
})
export class Banner {
  readonly tone = input<BannerTone>('warning');
}
