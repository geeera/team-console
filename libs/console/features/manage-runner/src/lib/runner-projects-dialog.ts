import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  RunnerScopePicker,
  RunnersApi,
  isRetryableRunnerFailure,
  runnerFailureKeyOf,
  type RunnerFailure,
  type RunnerProjectOption,
} from '@console/entities/runner';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, DIALOG_DATA, DialogRef, Icon, SheetFooter } from '@console/shared/ui';
import { runnerScopeCovers, type RunnerDto, type RunnerProjectScope } from '@shared/contracts';
import { scopeWideningOf } from './scope-widening';

export interface RunnerProjectsData {
  readonly accountId: string;
  readonly runner: RunnerDto;
  readonly projects: readonly RunnerProjectOption[];
}

let nextFormId = 0;

/**
 * Which projects one runner may serve (#464, #775, `PATCH …/runners/:runner`): the same scope picker as enrolment —
 * every project of the account, or a list — prefilled with the runner's scope. Saving a scope that drops a project the
 * runner serves now cancels its live jobs there (#490), so the dialog says so before the owner saves. Changing the
 * scope needs no re-enrolment: the claim reads the stored row and the runner takes the scope from each claim. Closes
 * with the runner as the Worker answered it.
 *
 * #825: an owner who may not widen the runner (`RunnerDto.canWiden`, #795) sees what they cannot add disabled, with
 * the reason under the picker; removing projects stays open. A refusal keeps its reason in the alert, and the button
 * offers Try again only for a failure the same request may get past.
 */
@Component({
  selector: 'tc-runner-projects-dialog',
  imports: [Banner, Button, Icon, RunnerScopePicker, SheetFooter, TranslocoPipe],
  template: `
    <form class="runner-projects-form" [id]="formId" (submit)="submit($event)" novalidate>
      @if (showsEnrollerNote()) {
        <p class="runner-projects-form__note" data-testid="runner-projects-enroller-only">
          {{ 'runners.err.enrollerOnly' | transloco }}
        </p>
      }
      <tc-runner-scope-picker
        [legend]="'runners.scope.editLegend' | transloco: { name: data.runner.name }"
        [projectsLegend]="'runners.projects.editLegend' | transloco: { name: data.runner.name }"
        [projects]="options()"
        [disabled]="running()"
        [allLocked]="widening().allLocked"
        [lockedSlugs]="widening().lockedSlugs"
        [(scope)]="scope"
        [(selected)]="selected"
      />
      @if (removed().length > 0) {
        <p
          class="runner-projects-form__note runner-projects-form__note--warning"
          data-testid="runner-projects-narrowing"
        >
          {{ 'runners.projects.narrowing' | transloco: { projects: removed().join(', ') } }}
        </p>
      }
      @if (failureKey(); as key) {
        <div tc-banner tone="danger" role="alert" data-testid="runner-projects-error">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ key | transloco }}</p>
        </div>
      }
    </form>
    <ng-template tcSheetFooter="primary">
      <button
        tc-button
        type="submit"
        variant="primary"
        data-testid="runner-projects-save"
        [attr.form]="formId"
        [loading]="running()"
        [attr.aria-disabled]="running() ? 'true' : null"
      >
        @if (running()) {
          {{ 'runners.projects.busy' | transloco }}
        } @else if (canRetry()) {
          {{ 'ui.error.retry' | transloco }}
        } @else {
          {{ 'runners.projects.save' | transloco }}
        }
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" [attr.aria-disabled]="running() ? 'true' : null" (click)="cancel()">
        {{ 'ui.confirm.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styles: `
    .runner-projects-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-4);
    }

    .runner-projects-form__note {
      margin: 0;
      font-size: var(--fs-sm);
      color: var(--text-2);
    }

    .runner-projects-form__note--warning {
      color: var(--warning-text);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunnerProjectsDialog {
  protected readonly data = inject<RunnerProjectsData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<RunnerDto>>(DialogRef);
  private readonly api = inject(RunnersApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  protected readonly formId = `tc-runner-projects-${nextFormId++}`;
  protected readonly scope = signal<RunnerProjectScope>(this.data.runner.projectScope);
  protected readonly selected = signal<readonly string[]>(this.data.runner.allowedProjects);
  protected readonly running = signal(false);
  protected readonly failure = signal<RunnerFailure | null>(null);
  protected readonly failureKey = computed(() => {
    const failure = this.failure();
    return failure === null ? null : runnerFailureKeyOf(failure);
  });
  protected readonly canRetry = computed(() => {
    const failure = this.failure();
    return failure !== null && isRetryableRunnerFailure(failure);
  });
  /** A stale list may still say `canWiden`; the Worker's enroller-only refusal settles it for this dialog. */
  private readonly widenRefused = signal(false);
  protected readonly canWiden = computed(() => this.data.runner.canWiden && !this.widenRefused());
  /** The alert says the same after a refusal; the note stays for the dialog's own reading of the list. */
  protected readonly showsEnrollerNote = computed(
    () => !this.canWiden() && this.failureKey() !== 'runners.err.enrollerOnly',
  );

  /** The account's projects plus any slug the runner holds that is no longer listed, so it can be unticked. */
  protected readonly options = computed((): readonly RunnerProjectOption[] => {
    const known = new Set(this.data.projects.map((project) => project.slug));
    const stale = this.data.runner.allowedProjects
      .filter((slug) => !known.has(slug))
      .map((slug) => ({ slug, displayName: slug }));
    return [...this.data.projects, ...stale];
  });

  protected readonly widening = computed(() =>
    scopeWideningOf(
      this.data.runner,
      this.canWiden(),
      this.options().map((project) => project.slug),
      this.selected(),
    ),
  );

  /** Projects the runner serves now that the new scope drops: their live jobs on it are cancelled by the save. */
  protected readonly removed = computed(() => {
    const next = { projectScope: this.scope(), allowedProjects: this.selected() };
    const serving = new Set([
      ...this.data.runner.servedProjects.map((project) => project.slug),
      ...this.data.runner.allowedProjects,
    ]);
    return [...serving].filter((slug) => !runnerScopeCovers(next, slug));
  });

  protected cancel(): void {
    if (!this.running()) {
      this.ref.close();
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.running()) {
      return;
    }
    this.running.set(true);
    this.failure.set(null);
    this.ref.disableClose = true;
    const result = await this.api.setScope(this.data.accountId, this.data.runner.id, {
      projectScope: this.scope(),
      allowedProjects: this.selected(),
    });
    this.running.set(false);
    this.ref.disableClose = false;
    if (!result.ok) {
      this.failure.set(result.failure);
      if (result.failure.kind === 'forbidden' && result.failure.slug === 'runner-scope-enroller-only') {
        this.widenRefused.set(true);
      }
      return;
    }
    void this.announcer.announce(
      this.transloco.translate('runners.projects.saved', { name: result.value.name }),
      'polite',
    );
    this.ref.close(result.value);
  }
}
