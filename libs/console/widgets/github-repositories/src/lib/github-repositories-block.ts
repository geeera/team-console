import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ConnectGitHubButton, GitHubConnectionStore } from '@console/entities/github-connection';
import { InstallationRepositoriesStore } from '@console/entities/installation-repository';
import { normalizeRepoInput } from '@console/entities/project';
import {
  AddProject,
  AddProjectForm,
  AddRepositorySheet,
  type AddJob,
  type AddJobState,
  type AddRepositorySheetData,
  type AddRepositorySheetResult,
} from '@console/features/add-project';
import { NetworkStatus } from '@console/shared/api';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Callout, Icon, Sheet, Toaster } from '@console/shared/ui';
import { slugFromRepoName, type InstallationRepositoryDto } from '@shared/contracts';
import { RepositoryListView, type RepositoryRowState } from './repository-list-view';

/** The checklist position (1–3) of the step a refusal names. */
const STEP_NUMBER: Readonly<Record<string, number>> = { app: 1, owner: 2, yml: 3 };

function rowStateOf(state: AddJobState): RepositoryRowState | null {
  if (state.kind === 'checking') {
    return { kind: 'checking' };
  }
  if (state.kind === 'added') {
    return null;
  }
  switch (state.outcome.kind) {
    case 'refused': {
      const missing = state.outcome.steps.find((step) => step.state === 'missing');
      return { kind: 'not-added', step: missing === undefined ? null : (STEP_NUMBER[missing.id] ?? null) };
    }
    // Already on the list or archived: the next read of the list says so on the row itself.
    case 'duplicate':
    case 'archived':
      return null;
    default:
      return { kind: 'not-added', step: null };
  }
}

/**
 * "Available on GitHub" on All projects (#194): the installation's repositories with Add on each, the #24 add
 * flow in the kit Sheet, and "Add by name" collapsed at the end. Nothing is requested while GitHub is not connected;
 * the list re-reads itself once (bypassing the Worker's cache) when the page is visible again after a GitHub link
 * from here, and when the browser is back online.
 */
@Component({
  selector: 'tc-github-repositories-block',
  imports: [AddProjectForm, Callout, ConnectGitHubButton, Icon, RepositoryListView, TranslocoPipe],
  templateUrl: './github-repositories-block.html',
  styleUrl: './github-repositories-block.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(click)': 'noteExternalLink($event)' },
})
export class GitHubRepositoriesBlock {
  private readonly adder = inject(AddProject);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly toaster = inject(Toaster);
  private readonly injector = inject(Injector);
  private readonly view = viewChild.required(RepositoryListView);

  protected readonly store = inject(InstallationRepositoriesStore);
  protected readonly connection = inject(GitHubConnectionStore);
  protected readonly network = inject(NetworkStatus);

  /** Adds started here, by lower-case full name; in memory only (gone after a reload, as the UX spec says). */
  private readonly jobs = signal<ReadonlyMap<string, AddJob>>(new Map());
  /** The job whose sheet is open, if any: a result for any other job lands on its row with a toast. */
  private openJob: AddJob | null = null;
  private leftForGitHub = false;

  protected readonly keepInPlace = signal<ReadonlySet<string>>(new Set());
  protected readonly byNameOpen = signal(false);
  protected readonly connectRefused = signal(false);
  protected readonly appName = computed(() => this.connection.appName() ?? 'team-console');

  protected readonly rowStates = computed<Readonly<Record<string, RepositoryRowState>>>(() => {
    const states: Record<string, RepositoryRowState> = {};
    for (const [key, job] of this.jobs()) {
      const state = rowStateOf(job.state());
      if (state !== null) {
        states[key] = state;
      }
    }
    return states;
  });

  constructor() {
    void this.connection.ready();

    // The list is read once GitHub is connected, and never before: no list request while not connected.
    effect(() => {
      if (this.connection.view() === 'connected' && this.store.status() === 'idle') {
        untracked(() => void this.store.load());
      }
    });

    // A 403 from the list means the connection is gone: the screen switches to Connect (#24's behaviour).
    effect(() => {
      if (this.store.problem()?.kind === 'not-connected') {
        untracked(() => this.connection.noteNotConnected());
      }
    });

    // Back online: one fresh read, so a list from before (or an add that did reach the Worker) tells the truth.
    let wasOnline = this.network.online();
    effect(() => {
      const online = this.network.online();
      if (online && !wasOnline && this.connection.view() === 'connected') {
        untracked(() => void this.store.load({ fresh: true }));
      }
      wasOnline = online;
    });

    const page = inject(DOCUMENT);
    const onVisible = (): void => {
      if (
        page.visibilityState === 'visible' &&
        this.leftForGitHub &&
        this.connection.view() === 'connected'
      ) {
        this.leftForGitHub = false;
        void this.store.load({ fresh: true });
      }
    };
    page.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => page.removeEventListener('visibilitychange', onVisible));
  }

  /** The entry points' target (#194): the section scrolled to the top, its heading focused. */
  revealHeading(): void {
    this.view().revealHeading();
  }

  protected noteExternalLink(event: Event): void {
    const link = event.target instanceof Element ? event.target.closest('a[target="_blank"]') : null;
    if (link !== null) {
      this.leftForGitHub = true;
    }
  }

  protected add(repo: InstallationRepositoryDto): void {
    const key = repo.fullName.toLowerCase();
    if (this.jobs().get(key)?.isRunning === true) {
      return;
    }
    const input = normalizeRepoInput(repo.fullName);
    const slug = input.ok ? input.slug : slugFromRepoName(repo.fullName.split('/')[1] ?? repo.fullName);
    const job: AddJob = this.adder.start(repo.fullName, slug, (state) => this.onSettled(job, state));
    this.jobs.update((jobs) => new Map(jobs).set(key, job));
    this.openSheet(job);
    void this.announcer.announce(
      this.transloco.translate('settings.add.checkingLive', { repo: repo.fullName }),
      'polite',
    );
    void job.run();
  }

  protected seeWhy(repo: InstallationRepositoryDto): void {
    const job = this.jobs().get(repo.fullName.toLowerCase());
    if (job !== undefined) {
      this.openSheet(job);
    }
  }

  protected async retry(): Promise<void> {
    const result = await this.store.load({ fresh: true });
    afterNextRender(() => (result === 'ready' ? this.view().focusHeading() : this.view().focusRetry()), {
      injector: this.injector,
    });
  }

  protected async refresh(): Promise<void> {
    const result = await this.store.load({ fresh: true });
    afterNextRender(() => this.view().focusRefresh(), { injector: this.injector });
    if (result === 'ready') {
      void this.announcer.announce(
        this.transloco.translate('overview.repos.refreshedLive', { n: this.store.repositories().length }),
        'polite',
      );
    }
  }

  protected toggleByName(): void {
    this.byNameOpen.update((open) => !open);
  }

  protected onConnectRefused(): void {
    this.connectRefused.set(true);
  }

  private openSheet(job: AddJob): void {
    this.openJob = job;
    const ref = this.sheet.open<AddRepositorySheetResult, AddRepositorySheetData>(AddRepositorySheet, {
      title: this.transloco.translate('overview.repos.sheet.title', { repo: job.repo }),
      data: { job },
      width: 'wide',
    });
    ref.closed.subscribe((result) => this.onSheetClosed(job, result));
  }

  private onSheetClosed(job: AddJob, result: AddRepositorySheetResult): void {
    if (this.openJob === job) {
      this.openJob = null;
    }
    // After an add the Add button the sheet opened from is gone: the row's link takes focus, not <body>. The
    // CDK restores focus to the opener after the overlay detaches, so this runs after it. Open setup leaves.
    if (job.state().kind === 'added' && result !== 'open-setup') {
      setTimeout(() => this.view().focusRow(job.repo));
    }
  }

  private onSettled(job: AddJob, state: AddJobState): void {
    if (state.kind === 'added') {
      this.keepInPlace.update((kept) => new Set(kept).add(job.repo.toLowerCase()));
      this.store.markRegistered(job.repo, state.slug);
    }
    if (this.openJob === job) {
      return;
    }
    // The sheet was closed mid-check: the row carries the result and the live region says it.
    if (state.kind === 'added') {
      const message = this.transloco.translate('overview.repos.addedToast', { repo: job.repo });
      this.toaster.show(message);
      void this.announcer.announce(message, 'polite');
    } else if (state.kind === 'refused') {
      void this.announcer.announce(
        this.transloco.translate('overview.repos.notAddedLive', { repo: job.repo }),
        'polite',
      );
    }
  }
}
