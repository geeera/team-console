import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import { ConnectGitHubButton, GitHubConnectionStore } from '@console/entities/github-connection';
import {
  pendingSetupSteps,
  projectSetupRouteOf,
  SetupChecklist,
  setupSummaryOf,
  type SetupChecklistContext,
  type SetupStep,
} from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoPluralPipe } from '@console/shared/i18n';
import { Button, Callout, Card, DIALOG_DATA, DialogRef, SheetFooter } from '@console/shared/ui';
import type { AddJob, AddRefusal } from './add-project';
import { JUST_ADDED_STATE } from './add-project-form';

export interface AddRepositorySheetData {
  readonly job: AddJob;
}

/** How the sheet was left: Done after an add, Open setup, or anything else (Close, Escape, the scrim). */
export type AddRepositorySheetResult = 'done' | 'open-setup' | undefined;

/**
 * The Add sheet of All projects (#194): the kit Sheet holding #24's checklist and result notes with their copy
 * unchanged, the actions in its footer. It shows the job, not a request of its own: closing it while the check
 * runs does not cancel anything, and the row carries the result.
 */
@Component({
  selector: 'tc-add-repository-sheet',
  imports: [
    Button,
    Callout,
    Card,
    ConnectGitHubButton,
    LocalTimePipe,
    RouterLink,
    SetupChecklist,
    SheetFooter,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './add-repository-sheet.html',
  styleUrl: './add-repository-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRepositorySheet {
  private readonly ref = inject<DialogRef<AddRepositorySheetResult>>(DialogRef);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly deployment = inject(DeploymentStore);

  protected readonly job = inject<AddRepositorySheetData>(DIALOG_DATA).job;
  protected readonly connection = inject(GitHubConnectionStore);
  protected readonly network = inject(NetworkStatus);
  protected readonly connectRefused = signal(false);
  protected readonly pending = pendingSetupSteps();

  private readonly result = viewChild<ElementRef<HTMLElement>>('result');

  protected readonly refusal = computed<AddRefusal | null>(() => {
    const state = this.job.state();
    return state.kind === 'refused' ? state.outcome : null;
  });
  protected readonly addedSteps = computed<readonly SetupStep[] | null>(() => {
    const state = this.job.state();
    return state.kind === 'added' ? state.steps : null;
  });
  protected readonly summary = computed(() => {
    const steps = this.addedSteps();
    return steps === null ? null : setupSummaryOf(steps);
  });
  protected readonly refusedSteps = computed<readonly SetupStep[]>(() => {
    const refusal = this.refusal();
    return refusal?.kind === 'refused' ? refusal.steps : [];
  });
  protected readonly isAuthFailure = computed(() => {
    const refusal = this.refusal();
    return refusal?.kind === 'unavailable' && refusal.reason === 'auth';
  });
  protected readonly retryAt = computed(() => {
    const refusal = this.refusal();
    return refusal?.kind === 'unavailable' && refusal.reason === 'rate' ? refusal.retryAt : null;
  });

  protected readonly context = computed<SetupChecklistContext>(() => {
    const refusal = this.refusal();
    const refused = refusal?.kind === 'refused' ? refusal : null;
    return {
      repo: this.job.repo,
      slug: this.job.slug,
      appName: this.connection.appName(),
      installUrl: refused?.installUrl ?? null,
      login: refused?.login ?? this.connection.login(),
      repoOwner: refused?.repoOwner ?? null,
      lastEventAt: null,
      environment: this.deployment.environment(),
    };
  });

  constructor() {
    void this.deployment.ensureLoaded();
    // A check that ends while the sheet is open moves focus to its result heading, as New project does (#24).
    let wasRunning = this.job.isRunning;
    effect(() => {
      const running = this.job.state().kind === 'checking';
      if (wasRunning && !running) {
        untracked(() =>
          afterNextRender(() => this.result()?.nativeElement.focus(), { injector: this.injector }),
        );
      }
      wasRunning = running;
    });
  }

  protected checkAgain(): void {
    if (this.job.isRunning || !this.network.online()) {
      return;
    }
    void this.job.run();
  }

  protected close(): void {
    this.ref.close(undefined);
  }

  protected done(): void {
    this.ref.close('done');
  }

  protected async openSetup(slug: string): Promise<void> {
    this.ref.close('open-setup');
    await this.router.navigate(projectSetupRouteOf(slug), { state: { [JUST_ADDED_STATE]: true } });
  }

  protected setupRoute(slug: string): readonly string[] {
    return projectSetupRouteOf(slug);
  }

  protected onConnectRefused(): void {
    this.connectRefused.set(true);
  }
}
