import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, ChipTone, Icon, IconName } from '@console/shared/ui';
import type { SprintCiState } from '@shared/contracts';
import type { SprintCiSummary } from './sprint.model';
import { SprintCiMemory } from './sprint-ci-memory';

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
 *
 * When a refresh moves the state from "running" to "passed" (#356), the mark's fill spreads from its centre and the
 * chip is lit for a moment by a `--success-soft` halo that fades out; under reduced motion the colour just changes.
 * Nothing plays on the first render or for any other change. With a `memoryKey` (the pull request, in its project) the
 * chip also remembers the state it last showed, so a board that reloaded whole in between still paints the change.
 */
@Component({
  selector: 'tc-sprint-ci-chip',
  imports: [Chip, Icon, TranslocoPipe],
  template: `<tc-chip class="sprint-ci__chip" [tone]="tone()" (animationend)="onAnimationEnd($event)"
    ><span class="sprint-ci__mark"
      ><span class="sprint-ci__fill" aria-hidden="true"></span><tc-icon [name]="icon()" size="sm" /></span
    >{{ 'board.ci.state.' + state() | transloco }}</tc-chip
  >`,
  styleUrl: './sprint-ci.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'sprint-ci-chip',
    '[attr.data-ci]': 'state()',
    '[class.sprint-ci-chip--painting]': 'isPainting()',
  },
})
export class SprintCiChip {
  readonly state = input.required<SprintCiState>();
  /** Identifies the pull request across reloads of the board; `null` compares only while the chip lives. */
  readonly memoryKey = input<string | null>(null);

  private readonly memory = inject(SprintCiMemory);

  protected readonly icon = computed(() => SPRINT_CI_ICONS[this.state()]);
  protected readonly tone = computed(() => TONES[this.state()]);
  protected readonly isPainting = signal(false);

  private previous: SprintCiState | null = null;

  constructor() {
    effect(() => {
      const next = this.state();
      const key = this.memoryKey();
      untracked(() => {
        const before = this.previous ?? (key === null ? null : this.memory.recall(key));
        this.isPainting.set(before === 'pending' && next === 'success');
        this.previous = next;
        if (key !== null) {
          this.memory.remember(key, next);
        }
      });
    });
  }

  protected onAnimationEnd(event: AnimationEvent): void {
    // The mark's fill ends first and bubbles here; the halo on the chip itself is the last motion.
    if (event.target === event.currentTarget) {
      this.isPainting.set(false);
    }
  }
}
