import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { localDayOf, localTimeOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Chip, ChipTone, Icon, IconName, List, ListRow } from '@console/shared/ui';
import type { RunEntryState, TeamRunState } from '@shared/contracts';
import type { SprintRun } from './sprint.model';

/** One glyph per team state (#132), so the "Run log" tile reads without its colour. */
export const TEAM_RUN_ICONS: Readonly<Record<TeamRunState, IconName>> = {
  running: 'play',
  paused: 'pause',
  failing: 'alert',
  unknown: 'question',
};

/** One glyph per run: a clock while it runs, ✓, ✗, a question mark for a run an edit touched. */
export const RUN_ENTRY_ICONS: Readonly<Record<RunEntryState, IconName>> = {
  running: 'clock',
  finished: 'check',
  failed: 'x',
  unknown: 'question',
};

const RUN_TONES: Readonly<Record<RunEntryState, ChipTone>> = {
  running: 'warning',
  finished: 'success',
  failed: 'danger',
  unknown: 'neutral',
};

/**
 * The team's latest runs (#132), newest first: the slot, when it ended (or started, while it runs) and how — icon and
 * words, the tone only repeating them. The last row opens the run-log issue on GitHub. Nothing here is a control
 * besides that link; the board never starts or stops a run.
 */
@Component({
  selector: 'tc-sprint-run-list',
  imports: [Chip, Icon, List, ListRow, TranslocoPipe],
  template: `
    <tc-list [attr.aria-label]="label()">
      @for (run of runs(); track $index) {
        <tc-list-row data-testid="run" [attr.data-state]="run.state" [attr.data-slot]="run.slotName">
          <span tc-row-title>{{ slotLabel(run) }}</span>
          @if (run.at) {
            <time tc-row-subtitle [attr.datetime]="run.at">{{ whenOf(run.at) }}</time>
          }
          <tc-chip tc-row-trailing [tone]="tone(run.state)" data-testid="run-state"
            ><tc-icon [name]="icon(run.state)" size="sm" />{{
              'board.run.state.' + run.state | transloco
            }}</tc-chip
          >
        </tc-list-row>
      }
      @if (runLogUrl(); as url) {
        <tc-list-row [href]="url" external data-testid="run-log-link">
          <tc-icon tc-row-leading name="github" />
          <span tc-row-title
            >{{ 'board.runs.log' | transloco
            }}<span class="tc-sr-only"> {{ 'board.opensGitHub' | transloco }}</span></span
          >
          <tc-icon tc-row-trailing name="external" size="sm" />
        </tc-list-row>
      }
    </tc-list>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SprintRunList {
  private readonly transloco = inject(TranslocoService);

  readonly runs = input.required<readonly SprintRun[]>();
  readonly runLogUrl = input<string | null>(null);
  /** The list's accessible name; the board has other lists. */
  readonly label = input<string | null>(null);

  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected slotLabel(run: SprintRun): string {
    this.lang();
    // A slot the console has no name for is shown as the run log writes it (plain text).
    return run.slot === null ? run.slotName : this.transloco.translate(`commands.slot.${run.slot}`);
  }

  protected whenOf(at: string): string {
    const lang = this.lang();
    return this.transloco.translate('board.run.at', {
      day: localDayOf(at, lang),
      time: localTimeOf(at, lang),
    });
  }

  protected icon(state: RunEntryState): IconName {
    return RUN_ENTRY_ICONS[state];
  }

  protected tone(state: RunEntryState): ChipTone {
    return RUN_TONES[state];
  }
}
