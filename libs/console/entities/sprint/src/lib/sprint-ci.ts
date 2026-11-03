import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, ChipTone, Icon, IconName } from '@console/shared/ui';
import type { SprintCiState } from '@shared/contracts';
import type { SprintCiSummary } from './sprint.model';

/** One glyph per CI state (#131), so the state reads without its colour: ✓, ✗, a clock, a dash, a question mark. */
export const SPRINT_CI_ICONS: Readonly<Record<SprintCiSummary['state'], IconName>> = {
  success: 'check',
  failure: 'x',
  pending: 'clock',
  none: 'minus',
  unknown: 'question',
  empty: 'minus',
};

const TONES: Readonly<Record<SprintCiState, ChipTone>> = {
  success: 'success',
  failure: 'danger',
  pending: 'warning',
  none: 'neutral',
  unknown: 'neutral',
};

/**
 * A pull request's CI as a chip: icon and words, the tone only repeating them. Inside a row link the words become
 * part of the link's name ("#61 feat: autosave … CI failed").
 */
@Component({
  selector: 'tc-sprint-ci-chip',
  imports: [Chip, Icon, TranslocoPipe],
  template: `<tc-chip [tone]="tone()"
    ><tc-icon [name]="icon()" size="sm" />{{ 'board.ci.state.' + state() | transloco }}</tc-chip
  >`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'sprint-ci-chip', '[attr.data-ci]': 'state()' },
})
export class SprintCiChip {
  readonly state = input.required<SprintCiState>();

  protected readonly icon = computed(() => SPRINT_CI_ICONS[this.state()]);
  protected readonly tone = computed(() => TONES[this.state()]);
}
