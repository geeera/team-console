import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  OrchestrationApi,
  orchestrationFailureKeyOf,
  OrchestrationStore,
  type OrchestrationFailure,
} from '@console/entities/orchestration';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, ConfirmFailure, Icon, Sheet } from '@console/shared/ui';
import type { OrchestrationDto, RunnerAvailability } from '@shared/contracts';
import { controlsViewOf } from './orchestration-controls.model';

let nextControlsId = 0;

/** The line under the button after a press: what happened, or why nothing did. */
export interface ControlsOutcome {
  readonly tone: 'positive' | 'neutral' | 'danger';
  readonly key: string;
}

/** Refusals that only say the run already is where the owner wanted it: neutral, not an error. */
const SETTLED: ReadonlySet<OrchestrationFailure['kind']> = new Set(['active', 'idle']);

/**
 * «Запустить команду» / «Остановить» (#1042, ADR 0010): the owner's Start and Stop of the console-driven run, beside
 * Run now on the board. One button that changes with the run, so focus stays on it across a press. Stop is a hard
 * cancel, so it asks first (`Sheet.confirm()`); a refusal there keeps the dialog open with its reason. Start is held
 * back, with the reason under it, when no runner serves the project. Every outcome and refusal is worded by the
 * problem slug, never the Worker's `detail`. Polls the run while shown (`OrchestrationStore`); after a command that
 * changed jobs it emits `changed`, so the host reads «Team jobs» again.
 */
@Component({
  selector: 'tc-orchestration-controls',
  imports: [Button, Icon, TranslocoPipe],
  providers: [OrchestrationStore],
  template: `
    <section
      class="orchestration"
      data-testid="orchestration"
      [attr.data-state]="store.run()?.state ?? store.status()"
      [attr.aria-labelledby]="titleId"
    >
      <h4 class="orchestration__title" [id]="titleId">{{ 'orchestration.title' | transloco }}</h4>
      <p class="orchestration__state" data-testid="orchestration-state">
        {{ view().stateKey | transloco: view().stateParams }}
      </p>
      <button
        tc-button
        type="button"
        class="orchestration__action"
        wrap
        data-testid="orchestration-action"
        [attr.data-action]="view().action"
        [variant]="view().action === 'start' ? 'primary' : 'danger'"
        [loading]="view().isBusy"
        [off]="view().isOff"
        [attr.aria-disabled]="view().isOff ? 'true' : null"
        [attr.aria-describedby]="view().reasonKey === null ? null : reasonId"
        (click)="press()"
      >
        @if (view().action === 'start') {
          <tc-icon name="play" size="sm" />
          {{ 'orchestration.start' | transloco }}
        } @else {
          <tc-icon name="x" size="sm" />
          {{ 'orchestration.stop' | transloco }}
        }
      </button>
      @if (view().reasonKey; as reason) {
        <p class="orchestration__reason" data-testid="orchestration-reason" [id]="reasonId">
          <tc-icon name="lock" size="sm" />
          <span>{{ reason | transloco }}</span>
        </p>
      }
      <!-- One live region for every outcome, so a screen reader hears the answer to the press either way. -->
      <p class="orchestration__outcome" role="status" data-testid="orchestration-outcome">
        @if (outcome(); as line) {
          <span [class]="'orchestration__outcome--' + line.tone" [attr.data-tone]="line.tone">{{
            line.key | transloco
          }}</span>
        } @else if (readFailure(); as failed) {
          <span class="orchestration__outcome--neutral" data-tone="neutral">{{
            failureKey(failed) | transloco
          }}</span>
        }
      </p>
    </section>
  `,
  styles: `
    .orchestration {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }

    .orchestration__title {
      margin: 0;
      font-size: var(--fs-md);
      font-weight: var(--fw-semibold);
    }

    .orchestration__state,
    .orchestration__reason,
    .orchestration__outcome {
      margin: 0;
      font-size: var(--fs-sm);
    }

    .orchestration__state {
      color: var(--text-2);
    }

    .orchestration__reason {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--text-2);
    }

    .orchestration__outcome:empty {
      display: none;
    }

    .orchestration__outcome--neutral {
      color: var(--text-2);
    }

    .orchestration__outcome--danger {
      color: var(--danger-text);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationControls {
  protected readonly store = inject(OrchestrationStore);
  private readonly api = inject(OrchestrationApi);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);

  readonly slug = input.required<string>();
  /** The jobs list's `runnerAvailability`: Start is held back for `none`, and says the step waits when away. */
  readonly availability = input<RunnerAvailability | null>(null);
  /** A command changed the project's jobs (a step queued, or the run's jobs cancelled). */
  readonly changed = output<OrchestrationDto>();

  protected readonly titleId = `tc-orchestration-${nextControlsId}`;
  protected readonly reasonId = `tc-orchestration-reason-${nextControlsId++}`;
  protected readonly isPending = signal(false);
  protected readonly outcome = signal<ControlsOutcome | null>(null);

  protected readonly view = computed(() =>
    controlsViewOf({
      status: this.store.status(),
      run: this.store.run(),
      availability: this.availability(),
      isPending: this.isPending(),
    }),
  );
  /** A failed read of the run, said only while no press has its own line. */
  protected readonly readFailure = computed(() =>
    this.store.status() === 'error' ? this.store.failure() : null,
  );

  constructor() {
    effect((onCleanup) => {
      const slug = this.slug();
      untracked(() => {
        this.outcome.set(null);
        onCleanup(this.store.watch(slug));
      });
    });
  }

  protected async press(): Promise<void> {
    const view = this.view();
    if (view.isOff) {
      return;
    }
    if (view.action === 'start') {
      await this.start();
    } else {
      await this.stop();
    }
  }

  protected failureKey(failure: OrchestrationFailure): string {
    return orchestrationFailureKeyOf(failure);
  }

  private async start(): Promise<void> {
    const slug = this.slug();
    this.isPending.set(true);
    this.outcome.set(null);
    try {
      const result = await this.api.start(slug);
      if (result.ok) {
        this.store.apply(result.value);
        const isRunnerAway = this.availability() === 'offline' || this.availability() === 'paused';
        this.outcome.set({
          tone: 'positive',
          key: isRunnerAway ? 'orchestration.outcome.startedWaiting' : 'orchestration.outcome.started',
        });
        this.changed.emit(result.value);
        return;
      }
      this.outcome.set(this.refusalOf(result.failure));
      if (SETTLED.has(result.failure.kind)) {
        await this.store.refresh();
      }
    } finally {
      this.isPending.set(false);
    }
  }

  private async stop(): Promise<void> {
    const t = (key: string): string => this.transloco.translate(key);
    const slug = this.slug();
    this.outcome.set(null);
    let outcome: ControlsOutcome | null = null;
    const isDone = await this.sheet.confirm({
      title: t('orchestration.confirm.title'),
      message: t('orchestration.confirm.message'),
      note: t('orchestration.confirm.note'),
      tone: 'danger',
      confirmLabel: t('orchestration.confirm.ok'),
      cancelLabel: t('orchestration.confirm.cancel'),
      retryLabel: t('orchestration.confirm.retry'),
      busyLabel: t('orchestration.confirm.busy'),
      errorMessage: t('orchestration.err.error'),
      action: async () => {
        this.isPending.set(true);
        try {
          outcome = await this.stopOutcome(slug, t);
        } finally {
          this.isPending.set(false);
        }
      },
    });
    this.outcome.set(isDone ? outcome : null);
  }

  /** Stop's answer as the line under the button; a refusal the owner can act on keeps the dialog open instead. */
  private async stopOutcome(slug: string, t: (key: string) => string): Promise<ControlsOutcome> {
    const result = await this.api.stop(slug);
    if (result.ok) {
      this.store.apply(result.value);
      this.changed.emit(result.value);
      return { tone: 'positive', key: 'orchestration.outcome.stopped' };
    }
    if (result.failure.kind === 'idle') {
      // Stopped elsewhere (or the run ended) since the last read: nothing to cancel, so the dialog closes.
      await this.store.refresh();
      return this.refusalOf(result.failure);
    }
    throw new ConfirmFailure(t(orchestrationFailureKeyOf(result.failure)));
  }

  private refusalOf(failure: OrchestrationFailure): ControlsOutcome {
    return {
      tone: SETTLED.has(failure.kind) ? 'neutral' : 'danger',
      key: orchestrationFailureKeyOf(failure),
    };
  }
}
