import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SprintRunList, type SprintTeam } from '@console/entities/sprint';
import { TranslocoPipe } from '@console/shared/i18n';
import { StateBlock } from '@console/shared/ui';

let nextRunLogId = 0;

/**
 * The GitHub run log under the team's jobs on a project still on GitHub Issues (#775, owner answer Q1): scheduled
 * routines report there, while the jobs started from the console are listed above it. The run log's own states
 * (#132, #201) are kept as they were.
 */
@Component({
  selector: 'tc-board-run-log',
  imports: [SprintRunList, StateBlock, TranslocoPipe],
  template: `
    <section class="run-log" data-testid="github-run-log" [attr.aria-labelledby]="titleId">
      <h3 class="run-log__title" [id]="titleId">{{ 'board.runs.githubLog' | transloco }}</h3>
      <p class="run-log__hint">{{ 'board.runs.githubLogHint' | transloco }}</p>
      @if (team().state === 'unknown') {
        <!-- An unknown team means the run log could not be read or trusted (#201): never "no runs yet" with a check. -->
        <tc-state-block
          kind="empty"
          compact
          icon="question"
          data-testid="runs-unavailable"
          [title]="'board.runs.unavailable' | transloco"
          [description]="'board.runs.unavailableHint' | transloco"
        />
      } @else if (team().recentRuns.length === 0) {
        <tc-state-block kind="empty" compact data-testid="runs-empty" [title]="'board.runs.empty' | transloco" />
      }
      @if (team().recentRuns.length > 0 || team().runLogUrl) {
        <tc-sprint-run-list
          [runs]="team().recentRuns"
          [runLogUrl]="team().runLogUrl"
          [teamState]="team().state"
          [label]="'board.runs.githubLog' | transloco"
        />
      }
    </section>
  `,
  styles: `
    .run-log {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: var(--border-w) solid var(--border);
    }

    .run-log__title {
      margin: 0;
      font-family: var(--font-display);
      font-size: var(--fs-lg);
      font-weight: var(--fw-display);
      line-height: var(--lh-tight);
    }

    .run-log__hint {
      margin: 0;
      color: var(--text-2);
      font-size: var(--fs-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardRunLog {
  readonly team = input.required<SprintTeam>();

  protected readonly titleId = `tc-board-run-log-${nextRunLogId++}`;
}
