import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
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
import { Router, RouterLink } from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import { ConnectGitHubButton, GitHubConnectionStore } from '@console/entities/github-connection';
import {
  pendingSetupSteps,
  ProjectSetupApi,
  ProjectsStore,
  SetupChecklist,
  setupStepsOf,
  setupSummaryOf,
  spaceUrlOf,
  type SetupChecklistContext,
} from '@console/entities/project';
import { JUST_ADDED_STATE } from '@console/features/add-project';
import { ArchiveProject } from '@console/features/archive-project';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, Card, Icon, StateBlock } from '@console/shared/ui';
import type { ProjectSetupDto } from '@shared/contracts';
import { FOCUS_AFTER_ARCHIVE_STATE, readNavigationState } from './settings-navigation';

/**
 * `/settings/projects/:slug` (#24): one project's five-step setup as the Worker reports it, Check again (bypasses the
 * Worker cache with `?fresh=1`), one automatic re-check when the app returns to the foreground, Open project, and
 * Archive project.
 */
@Component({
  selector: 'tc-project-setup-page',
  imports: [
    Button,
    Callout,
    Card,
    ConnectGitHubButton,
    Icon,
    LocalTimePipe,
    RouterLink,
    SetupChecklist,
    StateBlock,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './project-setup.page.html',
  styleUrls: ['./settings-subpage.css', './project-setup.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectSetupPage {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly setupApi = inject(ProjectSetupApi);
  private readonly archiver = inject(ArchiveProject);
  private readonly deployment = inject(DeploymentStore);

  protected readonly projects = inject(ProjectsStore);
  protected readonly connection = inject(GitHubConnectionStore);
  protected readonly network = inject(NetworkStatus);

  /** The route's `:slug` (component input binding). */
  readonly slug = input.required<string>();

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly result = viewChild<ElementRef<HTMLElement>>('result');

  protected readonly justAdded = signal(readNavigationState(this.router, JUST_ADDED_STATE) === true);
  protected readonly setup = signal<ProjectSetupDto | null>(null);
  protected readonly checking = signal(false);
  protected readonly failed = signal(false);
  protected readonly checkedAt = signal<string | null>(null);

  protected readonly project = computed(() => this.projects.bySlug(this.slug()));
  protected readonly steps = computed(() => {
    const setup = this.setup();
    return this.checking() || setup === null ? pendingSetupSteps() : setupStepsOf(setup);
  });
  protected readonly summary = computed(() => setupSummaryOf(this.steps()));
  protected readonly spaceUrl = computed(() => spaceUrlOf(this.slug(), undefined));
  protected readonly repoUrl = computed(() => {
    const repo = this.project()?.repo;
    return repo === undefined ? null : `https://github.com/${repo}`;
  });
  protected readonly checklistContext = computed<SetupChecklistContext | null>(() => {
    const project = this.project();
    if (project === undefined) {
      return null;
    }
    const setup = this.setup();
    return {
      repo: project.repo,
      slug: project.slug,
      appName: this.connection.appName(),
      installUrl: setup?.installUrl ?? null,
      login: setup?.connection.state === 'connected' ? setup.connection.login : null,
      repoOwner: setup?.repoOwnerLogin ?? null,
      lastEventAt: setup?.lastEventAt ?? null,
      environment: this.deployment.environment(),
    };
  });
  /** The connection the setup status reported; Connect is offered here when it is missing (ADR 0003). */
  protected readonly connectionBanner = computed<'none' | 'lost' | null>(() => {
    const view = this.connection.view();
    return view === 'not-connected' ? 'none' : view === 'lost' ? 'lost' : null;
  });

  constructor() {
    void this.connection.ready();
    void this.deployment.ensureLoaded();

    let started = false;
    effect(() => {
      if (this.projects.status() !== 'ready' || started) {
        return;
      }
      started = true;
      untracked(() => {
        if (this.project() === undefined) {
          afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
          return;
        }
        void this.check({ fresh: false, announce: false });
      });
    });
    void this.projects.ready();

    // Back from GitHub (or a terminal) with a step missing: check once by itself (UX spec §2).
    const document = inject(DOCUMENT);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && this.needsRecheck()) {
        void this.check({ fresh: true, announce: true });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }

  protected recheck(): void {
    if (this.checking() || !this.network.online()) {
      return;
    }
    this.justAdded.set(false);
    void this.check({ fresh: true, announce: true });
  }

  protected async archive(): Promise<void> {
    const project = this.project();
    if (project === undefined || !this.network.online()) {
      return;
    }
    const index = this.projects.activeSlugs().indexOf(project.slug);
    if (await this.archiver.archive(project)) {
      await this.router.navigate(['/settings'], { state: { [FOCUS_AFTER_ARCHIVE_STATE]: index } });
    }
  }

  private needsRecheck(): boolean {
    return !this.checking() && this.setup() !== null && this.network.online() && !this.summary().ready;
  }

  private async check(options: { fresh: boolean; announce: boolean }): Promise<void> {
    this.checking.set(true);
    this.failed.set(false);
    try {
      const setup = await this.setupApi.get(this.slug(), { fresh: options.fresh });
      this.setup.set(setup);
      this.checkedAt.set(new Date().toISOString());
      this.connection.syncFrom(setup.connection.state);
    } catch {
      // The setup page stays on the last answer, if any, and offers Check again; nothing here was written.
      this.failed.set(true);
    } finally {
      this.checking.set(false);
    }
    afterNextRender(() => (options.announce ? this.result() : this.heading())?.nativeElement.focus(), {
      injector: this.injector,
    });
    if (options.announce && !this.failed()) {
      const done = this.summary().done;
      await this.announcer.announce(this.transloco.translate('settings.setup.doneLive', { done }), 'polite');
    }
  }
}
