import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import {
  jobFailureKeyOf,
  JobsApi,
  RUN_NOW_KINDS,
  type JobFailure,
  type RunNowKind,
} from '@console/entities/job';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Field, FieldControl, Icon } from '@console/shared/ui';
import type { JobDto } from '@shared/contracts';

let nextRunNowId = 0;

/**
 * Run now (#464, ADR 0008 row 2-E): a kind picker and one button that queues a job of that kind for the project
 * (`POST …/jobs`). The button waits while the request is out, so a double press queues nothing twice (the Worker's
 * dedupe key answers a repeat slot with 409 `job-exists` anyway). A refusal is said under the button, worded by the
 * problem slug; the queued job is emitted for the view to show at once.
 */
@Component({
  selector: 'tc-run-now',
  imports: [Button, Field, FieldControl, Icon, TranslocoPipe],
  template: `
    <form class="run-now" data-testid="run-now" [attr.aria-labelledby]="titleId" (submit)="run($event)">
      <h3 class="run-now__title" [id]="titleId">{{ 'jobs.runNow.title' | transloco }}</h3>
      <div class="run-now__row">
        <tc-field class="run-now__kind" [label]="'jobs.runNow.kind' | transloco" required>
          <select
            tcInput
            data-testid="run-now-kind"
            [disabled]="submitting()"
            (change)="choose($any($event.target).value)"
          >
            @for (kind of kinds; track kind) {
              <option [value]="kind" [selected]="kind === selected()">
                {{ 'jobs.kind.' + kind | transloco }}
              </option>
            }
          </select>
        </tc-field>
        <button
          tc-button
          variant="primary"
          type="submit"
          class="run-now__submit"
          data-testid="run-now-submit"
          [loading]="submitting()"
          [disabled]="submitting()"
        >
          <tc-icon name="play" size="sm" />
          {{ 'jobs.runNow.submit' | transloco }}
        </button>
      </div>
      <!-- One live region for both outcomes, so a screen reader hears the answer to the press either way. -->
      <p class="run-now__outcome" role="status" data-testid="run-now-outcome">
        @if (failure(); as failed) {
          <span class="run-now__error" data-testid="run-now-error" [attr.data-kind]="failed.kind">{{
            failureKey(failed) | transloco
          }}</span>
        } @else if (queuedKind(); as kind) {
          <span data-testid="run-now-queued">{{
            'jobs.runNow.queued' | transloco: { kind: ('jobs.kind.' + kind | transloco) }
          }}</span>
        }
      </p>
    </form>
  `,
  styles: `
    .run-now {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .run-now__title {
      margin: 0;
      font-size: var(--fs-md);
      font-weight: var(--fw-semibold);
    }

    .run-now__row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: var(--space-2);
    }

    .run-now__kind {
      flex: 1 1 var(--card-min-w);
    }

    .run-now__outcome {
      margin: 0;
      font-size: var(--fs-sm);
    }

    .run-now__outcome:empty {
      display: none;
    }

    .run-now__error {
      color: var(--danger-text);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunNow {
  private readonly api = inject(JobsApi);

  readonly slug = input.required<string>();
  /** The job the Worker queued. */
  readonly enqueued = output<JobDto>();

  protected readonly titleId = `tc-run-now-${nextRunNowId++}`;
  protected readonly kinds = RUN_NOW_KINDS;
  protected readonly selected = signal<RunNowKind>(RUN_NOW_KINDS[0]);
  protected readonly submitting = signal(false);
  protected readonly failure = signal<JobFailure | null>(null);
  protected readonly queuedKind = signal<RunNowKind | null>(null);

  protected choose(value: string): void {
    const kind = RUN_NOW_KINDS.find((candidate) => candidate === value);
    if (kind !== undefined) {
      this.selected.set(kind);
    }
  }

  protected async run(event: Event): Promise<void> {
    event.preventDefault();
    if (this.submitting()) {
      return;
    }
    const kind = this.selected();
    this.submitting.set(true);
    this.failure.set(null);
    this.queuedKind.set(null);
    try {
      const result = await this.api.enqueue(this.slug(), kind);
      if (result.ok) {
        this.queuedKind.set(kind);
        this.enqueued.emit(result.value);
      } else {
        this.failure.set(result.failure);
      }
    } finally {
      this.submitting.set(false);
    }
  }

  protected failureKey(failure: JobFailure): string {
    return jobFailureKeyOf(failure);
  }
}
