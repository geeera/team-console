import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon, IconName } from '@console/shared/ui';
import type { SprintTier } from '@shared/contracts';

export type SprintTierIconSize = 'md' | 'sm';

const GLYPHS: Readonly<Record<SprintTier, IconName>> = {
  light: 'tier-light',
  standard: 'tier-standard',
  heavy: 'tier-heavy',
};

/**
 * An issue's tier as a meter of one to three bars on a tile in the tier's tone (the colours of the former tier
 * chips; the bar count alone tells the tier). Decorative: the caller puts the tier's name next to it as text, or as
 * visually hidden text in the same link. Projected content (a `tc-tooltip`) is anchored to the tile.
 */
@Component({
  selector: 'tc-sprint-tier-icon',
  imports: [Icon],
  template: `<tc-icon class="sprint-tier-icon__glyph" [name]="glyph()" /><ng-content />`,
  styleUrl: './sprint-tier-icon.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'sprint-tier-icon',
    '[class.sprint-tier-icon--light]': 'tier() === "light"',
    '[class.sprint-tier-icon--standard]': 'tier() === "standard"',
    '[class.sprint-tier-icon--heavy]': 'tier() === "heavy"',
    '[class.sprint-tier-icon--sm]': 'size() === "sm"',
    '[attr.data-tier]': 'tier()',
  },
})
export class SprintTierIcon {
  readonly tier = input.required<SprintTier>();
  readonly size = input<SprintTierIconSize>('md');

  protected readonly glyph = computed(() => GLYPHS[this.tier()]);
}
