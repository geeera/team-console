import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { actionsSummaryOf, ActionsSetupStatuses, missingStepsOf } from '@console/entities/actions-setup';
import { actionsFirstJobOf, JobsApi, type ActionsFirstJob } from '@console/entities/job';
import { projectSetupRouteOf, ProjectsStore, spaceUrlOf } from '@console/entities/project';
import { RunnersApi } from '@console/entities/runner';
import { ActionsSetupLedger } from '@console/features/actions-setup';
import { teamSettingsUrlOf } from '@console/features/team-config';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, focusAfterRender, Icon, StateBlock } from '@console/shared/ui';
import type { ProjectDispatchDto } from '@shared/contracts';

/** After this long without an answer the loading state says the check can take up to ten seconds (UX spec §6). */
export const ACTIONS_SLOW_CHECK_MS = 3000;

/**
 * `/settings/projects/:slug/actions` (#759): the customer's own GitHub Actions setup, a sibling of the project's
 * environment screen. One readiness check on entry, on «Проверить снова», and once when the tab comes back from
 * GitHub (at most every 30 s); a member gets the forbidden state and GitHub is never asked (the Worker answers 403
 * before any mint). The page holds no secret but the fixed name `TC_INFERENCE_API_KEY`.
 */
@Component({
  selector: 'tc-project-actions-page',
  imports: [
    ActionsSetupLedger,
    Button,
    Callout,
    Icon,
    LocalTimePipe,
    RouterLink,
    StateBlock,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './project-actions.page.html',
  styleUrls: ['../settings-subpage.css', './project-actions.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectActionsPage {
  private readonly statuses = inject(ActionsSetupStatuses);
  private readonly runners = inject(RunnersApi);
  private readonly jobs = inject(JobsApi);
  private readonly injector = inject(Injector);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  protected readonly projects = inject(ProjectsStore);
  protected readonly network = inject(NetworkStatus);

  /** The route's `:slug`. */
  readonly slug = input.required<string>();
  /** `?from=runners`: the success state offers the way back. */
  readonly from = input<string | undefined>(undefined);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly result = viewChild<ElementRef<HTMLElement>>('result');

  protected readonly project = computed(() => this.projects.bySlug(this.slug()));
  protected readonly status = computed(() => this.statuses.of(this.slug()));
  protected readonly snapshot = computed(() => this.status().snapshot());
  protected readonly problem = computed(() => this.status().problem());
  protected readonly isChecking = computed(() => this.status().state() === 'loading' || this.status().state() === 'idle');
  protected readonly summary = computed(() => {
    const snapshot = this.snapshot();
    return snapshot === null ? null : actionsSummaryOf(snapshot);
  });
  /** `GET …/dispatch`'s branch, for before the first check answers or when it could not read the repository. */
  private readonly dispatchBranch = signal<string | null>(null);
  /** The check names the default branch it read (#870); a first-time project has none recorded yet. */
  protected readonly branch = computed(() => this.snapshot()?.defaultBranch ?? this.dispatchBranch());
  protected readonly isSlow = signal(false);
  protected readonly justSwitched = signal(false);
  /** Step 6; `null` until the jobs were read, and when they cannot be (a member, an error): the step then stays out. */
  protected readonly firstJob = signal<ActionsFirstJob | null>(null);

  protected readonly setupRoute = computed(() => projectSetupRouteOf(this.slug()));
  protected readonly spaceUrl = computed(() => spaceUrlOf(this.slug(), undefined));
  protected readonly teamUrl = computed(() => teamSettingsUrlOf(this.slug()));
  protected readonly repoUrl = computed(() => {
    const repo = this.project()?.repo;
    return repo === undefined ? null : `https://github.com/${repo}`;
  });
  protected readonly branchLabel = computed(() => this.branch() ?? this.transloco.translate('actions.branchFallback'));
  /** A block replaces the ledger: nothing to show, or nothing this session may see. */
  protected readonly blockingProblem = computed(() => {
    const problem = this.problem();
    if (problem === null || this.status().state() !== 'error') {
      return null;
    }
    if (problem.kind === 'forbidden' || problem.kind === 'not-found') {
      return problem;
    }
    return this.snapshot() === null ? problem : null;
  });
  protected readonly rateRetryAt = computed(() => {
    const problem = this.problem();
    return problem?.kind === 'rate' && this.status().state() === 'error' ? problem.retryAt : null;
  });
  protected readonly isOfflineSnapshot = computed(
    () => this.status().state() === 'error' && this.problem()?.kind === 'offline' && this.snapshot() !== null,
  );
  protected readonly isRecheckBlocked = computed(
    () => this.isChecking() || !this.network.online() || this.rateRetryAt() !== null,
  );

  protected readonly summaryTone = computed(() => {
    const kind = this.summary()?.kind;
    return kind === 'ready' || kind === 'on' ? 'success' : kind === undefined ? 'neutral' : 'warning';
  });

  protected problemTitle(kind: string): string {
    switch (kind) {
      case 'github':
        return 'actions.err.github';
      case 'misconfigured':
        return 'actions.err.misconfigured';
      case 'unverified':
        return 'actions.err.unverified';
      case 'offline':
        return 'actions.err.offline0';
      case 'rate':
        return 'runners.err.rateLimited';
      default:
        return 'actions.err.load';
    }
  }

  constructor() {
    let started: string | null = null;
    effect(() => {
      if (this.projects.status() !== 'ready') {
        return;
      }
      const slug = this.slug();
      if (started === slug) {
        return;
      }
      started = slug;
      untracked(() => {
        focusAfterRender(() => this.heading(), { injector: this.injector });
        if (this.project() !== undefined) {
          void this.check({ announce: false });
          void this.loadBranch(slug);
        }
      });
    });
    void this.projects.ready();

    // The jobs are read again whenever a new answer says the project runs on Actions, so the step follows a re-check.
    effect(() => {
      const snapshot = this.snapshot();
      const slug = this.slug();
      untracked(() => {
        if (snapshot?.dispatch === 'actions') {
          void this.loadFirstJob(slug);
        } else {
          this.firstJob.set(null);
        }
      });
    });

    // Back from GitHub: one check by itself, announced only when the result changed (UX spec §2 "Re-check").
    const document = inject(DOCUMENT);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && this.project() !== undefined && this.network.online()) {
        void this.autoRecheck();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }

  protected recheck(): void {
    if (this.isRecheckBlocked()) {
      return;
    }
    void this.check({ announce: true });
  }

  protected onSwitched(dto: ProjectDispatchDto): void {
    this.status().applyDispatch(dto.dispatch);
    if (dto.defaultBranch !== null) {
      this.dispatchBranch.set(dto.defaultBranch);
    }
    this.justSwitched.set(true);
    focusAfterRender(() => this.result(), { injector: this.injector });
  }

  private async check(options: { announce: boolean }): Promise<void> {
    const timer = setTimeout(() => this.isSlow.set(true), ACTIONS_SLOW_CHECK_MS);
    try {
      await this.status().load();
    } finally {
      clearTimeout(timer);
      this.isSlow.set(false);
    }
    if (options.announce) {
      focusAfterRender(() => this.result(), { injector: this.injector, onlyIfFocusLost: true });
      await this.announceDone();
    }
  }

  private async autoRecheck(): Promise<void> {
    const before = this.missingCount();
    if (await this.status().autoRecheck()) {
      if (this.missingCount() !== before) {
        await this.announceDone();
      }
    }
  }

  private missingCount(): number | null {
    const snapshot = this.snapshot();
    return snapshot === null ? null : missingStepsOf(snapshot).length;
  }

  private async announceDone(): Promise<void> {
    const missing = this.missingCount();
    if (missing === null || this.status().state() !== 'ready') {
      return;
    }
    const total = 4;
    await this.announcer.announce(
      this.transloco.translate('actions.doneLive', { done: total - missing, total }),
      'polite',
    );
  }

  private async loadFirstJob(slug: string): Promise<void> {
    const result = await this.jobs.list(slug);
    if (this.slug() !== slug) {
      return;
    }
    this.firstJob.set(result.ok ? actionsFirstJobOf(result.value.jobs) : null);
  }

  /** The default branch names the rule and the file; when GitHub was never asked, the copy says «по умолчанию». */
  private async loadBranch(slug: string): Promise<void> {
    const result = await this.runners.dispatch(slug);
    if (result.ok && this.slug() === slug) {
      this.dispatchBranch.set(result.value.defaultBranch);
    }
  }
}
