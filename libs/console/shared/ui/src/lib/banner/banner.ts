import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

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
 *
 * `note` turns it into a paper note held by a paperclip (#357): it drops into place on entry, and a caller that
 * wants it to lift away on removal adds `animate.leave="tc-banner--leaving"`.
 */
@Component({
  selector: '[tc-banner]',
  imports: [Icon],
  template: `
    @if (note()) {
      <tc-icon class="tc-banner__clip" name="paperclip" />
    }
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
    '[class.tc-banner--note]': 'note()',
  },
})
export class Banner {
  readonly tone = input<BannerTone>('warning');
  /** A paper note with a paperclip instead of a flat strip. */
  readonly note = input(false, { transform: booleanAttribute });
}
