import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  RunnerScopePicker,
  RunnersApi,
  runnerFailureKeyOf,
  type RunnerProjectOption,
} from '@console/entities/runner';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, DIALOG_DATA, DialogRef, Icon, SheetFooter } from '@console/shared/ui';
import { runnerScopeCovers, type RunnerDto, type RunnerProjectScope } from '@shared/contracts';

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
 */
@Component({
  selector: 'tc-runner-projects-dialog',
  imports: [Banner, Button, Icon, RunnerScopePicker, SheetFooter, TranslocoPipe],
  template: `
    <form class="runner-projects-form" [id]="formId" (submit)="submit($event)" novalidate>
      <tc-runner-scope-picker
        [legend]="'runners.scope.editLegend' | transloco: { name: data.runner.name }"
        [projectsLegend]="'runners.projects.editLegend' | transloco: { name: data.runner.name }"
        [projects]="options()"
        [disabled]="running()"
        [(scope)]="scope"
        [(selected)]="selected"
      />
      @if (removed().length > 0) {
        <p class="runner-projects-form__warning" data-testid="runner-projects-narrowing">
          {{ 'runners.projects.narrowing' | transloco: { projects: removed().join(', ') } }}
        </p>
      }
      @if (failure(); as message) {
        <div tc-banner tone="danger" role="alert" data-testid="runner-projects-error">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ message }}</p>
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
        } @else if (failure() !== null) {
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

    .runner-projects-form__warning {
      margin: 0;
      font-size: var(--fs-sm);
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
  protected readonly failure = signal<string | null>(null);

  /** The account's projects plus any slug the runner holds that is no longer listed, so it can be unticked. */
  protected readonly options = computed((): readonly RunnerProjectOption[] => {
    const known = new Set(this.data.projects.map((project) => project.slug));
    const stale = this.data.runner.allowedProjects
      .filter((slug) => !known.has(slug))
      .map((slug) => ({ slug, displayName: slug }));
    return [...this.data.projects, ...stale];
  });

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
      this.failure.set(this.transloco.translate(runnerFailureKeyOf(result.failure)));
      return;
    }
    void this.announcer.announce(
      this.transloco.translate('runners.projects.saved', { name: result.value.name }),
      'polite',
    );
    this.ref.close(result.value);
  }
}
