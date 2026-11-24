import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type LiveDotTone = 'accent' | 'success';
export type LiveDotDepth = 'soft' | 'deep';

/**
 * A small dot that breathes while something is live. Decorative: the words beside it carry the meaning.
 * `depth` is how far the opacity dips (soft 0.5, deep 0.3); `paused` freezes the pulse, e.g. in a hidden tab.
 * Under reduced motion it stays still at full strength.
 */
@Component({
  selector: 'tc-live-dot',
  template: '',
  styleUrl: './live-dot.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-live-dot',
    '[class.tc-live-dot--success]': 'tone() === "success"',
    '[class.tc-live-dot--deep]': 'depth() === "deep"',
    '[class.tc-live-dot--paused]': 'paused()',
    'aria-hidden': 'true',
  },
})
export class LiveDot {
  readonly tone = input<LiveDotTone>('accent');
  readonly depth = input<LiveDotDepth>('soft');
  readonly paused = input(false);
}
