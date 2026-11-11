import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { JobCard, jobFailureKeyOf, JobsStore, runnerLabelOf, type JobFailure } from '@console/entities/job';
import { RunNow } from '@console/features/run-now';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Icon, StateBlock } from '@console/shared/ui';
import type { JobDto } from '@shared/contracts';

/**
 * The board's runs section for a console-tracker project (#464, ADR 0008 row 2-E): Run now, then the jobs a runner
 * holds and the queue (each with its runner and the tail of its events), then the last jobs that ended. Reads the
 * board's `JobsStore`; runner names come from the caller, who reads the account's runners.
 */
@Component({
  selector: 'tc-board-jobs',
  imports: [Button, Icon, JobCard, RunNow, StateBlock, TranslocoPipe],
  template: `
    <tc-run-now class="board-jobs__run-now" [slug]="slug()" (enqueued)="onEnqueued($event)" />

    @switch (store.status()) {
      @case ('forbidden') {
        <tc-state-block
          kind="empty"
          compact
          icon="lock"
          data-testid="jobs-forbidden"
          [title]="'jobs.view.forbiddenTitle' | transloco"
          [description]="'jobs.view.forbiddenHint' | transloco"
        />
      }
      @case ('error') {
        <tc-state-block
          kind="error"
          compact
          data-testid="jobs-error"
          [title]="'jobs.view.errorTitle' | transloco"
          [description]="failureKey(store.failure()) | transloco"
        >
          <button tc-button tc-state-action type="button" (click)="refresh()">
            {{ 'ui.error.retry' | transloco }}
          </button>
        </tc-state-block>
      }
      @case ('ready') {
        <div class="board-jobs__head">
          <h3 class="board-jobs__title">{{ 'jobs.view.current' | transloco }}</h3>
          <button
            tc-button
            size="sm"
            variant="quiet"
            type="button"
            data-testid="jobs-refresh"
            [loading]="store.refreshing()"
            (click)="refresh()"
          >
            <tc-icon name="refresh" size="sm" />
            {{ 'jobs.view.refresh' | transloco }}
          </button>
        </div>
        @if (store.failure(); as stale) {
          <p class="board-jobs__note" role="status" data-testid="jobs-stale">
            {{ 'jobs.view.staleNote' | transloco }} {{ failureKey(stale) | transloco }}
          </p>
        }
        @if (store.current().length > 0) {
          <ul class="board-jobs__list" data-testid="jobs-current">
            @for (job of store.current(); track job.id) {
              <li>
                <tc-job-card
                  [job]="job"
                  [runnerName]="runnerOf(job)"
                  [events]="store.eventsOf(job.id)"
                  [eventsFailed]="store.eventFailures().has(job.id)"
                />
              </li>
            }
          </ul>
        } @else {
          <tc-state-block
            kind="empty"
            compact
            data-testid="jobs-empty"
            [title]="'jobs.view.empty' | transloco"
            [description]="'jobs.view.emptyHint' | transloco"
          />
        }
        <h3 class="board-jobs__title">{{ 'jobs.view.recent' | transloco }}</h3>
        @if (store.recent().length > 0) {
          <ul class="board-jobs__list" data-testid="jobs-recent">
            @for (job of store.recent(); track job.id) {
              <li>
                <tc-job-card [job]="job" [runnerName]="runnerOf(job)" [events]="store.eventsOf(job.id)" />
              </li>
            }
          </ul>
        } @else {
          <p class="board-jobs__note" data-testid="jobs-recent-empty">
            {{ 'jobs.view.recentEmpty' | transloco }}
          </p>
        }
      }
      @default {
        <tc-state-block
          kind="loading"
          compact
          data-testid="jobs-loading"
          [title]="'jobs.view.loading' | transloco"
        />
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .board-jobs__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .board-jobs__title {
      margin: 0;
      font-size: var(--fs-md);
      font-weight: var(--fw-semibold);
    }

    .board-jobs__list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .board-jobs__note {
      margin: 0;
      color: var(--text-2);
      font-size: var(--fs-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardJobs {
  protected readonly store = inject(JobsStore);

  readonly slug = input.required<string>();
  /** Runner id → name, for the runners the caller could list (none for a member of the account). */
  readonly runnerNames = input<ReadonlyMap<string, string>>(new Map());

  protected runnerOf(job: JobDto): string {
    return job.runnerId === null ? '' : runnerLabelOf(job.runnerId, this.runnerNames());
  }

  protected failureKey(failure: JobFailure | null): string {
    return jobFailureKeyOf(failure ?? { kind: 'error', slug: null });
  }

  protected onEnqueued(job: JobDto): void {
    this.store.add(job);
    void this.store.refresh();
  }

  protected refresh(): void {
    void this.store.refresh();
  }
}
