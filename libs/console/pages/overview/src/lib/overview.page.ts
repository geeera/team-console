import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ErrorHandler,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ADD_PROJECT_FRAGMENT,
  AnsweredItems,
  OverviewApi,
  ProjectsStore,
  UnexpectedOverviewResponse,
  type OverviewProject,
} from '@console/entities/project';
import { httpProblemOf } from '@console/shared/api';
import { TranslocoPipe, TranslocoPluralPipe } from '@console/shared/i18n';
import { Banner, Button, Icon, SrOnlyOnPhone, StateBlock } from '@console/shared/ui';
import { GitHubRepositoriesBlock } from '@console/widgets/github-repositories';
import { OVERVIEW_PENDING_PROBLEM, OverviewTile } from './overview-tile';

export type OverviewFailure = 'rate-limited' | 'offline' | 'unavailable';

type OverviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly projects: readonly OverviewProject[] }
  | { readonly kind: 'failed'; readonly failure: OverviewFailure };

interface TileRow {
  readonly project: OverviewProject;
  readonly waiting: number;
}

/**
 * `/overview` (#27, ADR 0001 decision 24): every active project at a glance, read-only, from one request. Projects
 * with something for the owner — or that could not be read — come first, the quiet ones below (Paper Desk
 * direction). Tapping a project opens its board. When the Worker's request budget left some projects unread, they
 * say so in their tile and "Load the rest" asks again; the Worker continues from its cache. Below the projects,
 * "Available on GitHub" (#194) lists the repositories to add from; every "Add project" entry point lands there.
 */
@Component({
  selector: 'tc-overview-page',
  imports: [
    Banner,
    Button,
    GitHubRepositoriesBlock,
    Icon,
    OverviewTile,
    SrOnlyOnPhone,
    StateBlock,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './overview.page.html',
  styleUrl: './overview.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {
  private readonly api = inject(OverviewApi);
  private readonly answered = inject(AnsweredItems);
  private readonly errors = inject(ErrorHandler);
  protected readonly projects = inject(ProjectsStore);
  private readonly repositories = viewChild.required(GitHubRepositoriesBlock);

  protected readonly state = signal<OverviewState>({ kind: 'loading' });
  /** A reload keeps the rows on screen; only the action shows it is busy. */
  protected readonly reloading = signal(false);
  private loadToken = 0;

  private readonly rows = computed<TileRow[]>(() => {
    const state = this.state();
    if (state.kind !== 'ready') {
      return [];
    }
    return state.projects.map((project) => ({
      project,
      waiting:
        project.kind === 'read'
          ? project.needsYou.filter((number) => !this.answered.has(project.slug, number)).length
          : 0,
    }));
  });

  protected readonly count = computed(() => this.rows().length);
  /** Read projects with nothing waiting go below the others, as the direction's "quiet projects". */
  protected readonly attention = computed(() => this.rows().filter((row) => !this.isQuiet(row)));
  protected readonly quiet = computed(() => this.rows().filter((row) => this.isQuiet(row)));
  protected readonly isPartial = computed(() =>
    this.rows().some(
      (row) => row.project.kind === 'failed' && row.project.problem === OVERVIEW_PENDING_PROBLEM,
    ),
  );
  protected readonly failure = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? state.failure : null;
  });

  constructor() {
    // The registry decides between the empty state and the overview; read the overview once it has projects, and
    // again whenever its active projects change — an add from "Available on GitHub" below (#242) or an archive —
    // so the tiles agree with the switcher without a reload. The tiles stay on screen while it reloads.
    let readFor: string | null = null;
    effect(() => {
      if (this.projects.status() !== 'ready' || !this.projects.hasProjects()) {
        return;
      }
      const slugs = [...this.projects.activeSlugs()].sort().join(' ');
      if (slugs !== readFor) {
        readFor = slugs;
        untracked(() => void this.load());
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
    });

    // Every "Add project" entry point lands here with #add-project: the GitHub section, its heading focused. The
    // fragment is dropped once used, so the next entry point is a new navigation and lands there again.
    const router = inject(Router);
    const injector = inject(Injector);
    inject(ActivatedRoute)
      .fragment.pipe(takeUntilDestroyed())
      .subscribe((fragment) => {
        if (fragment !== ADD_PROJECT_FRAGMENT) {
          return;
        }
        afterNextRender(
          () => {
            this.repositories().revealHeading();
          },
          { injector },
        );
        void router.navigate([], { replaceUrl: true });
      });
  }

  protected async reload(): Promise<void> {
    if (this.state().kind !== 'ready') {
      this.state.set({ kind: 'loading' });
    }
    await this.load();
  }

  private isQuiet(row: TileRow): boolean {
    return row.project.kind === 'read' && row.waiting === 0;
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    this.reloading.set(true);
    try {
      const projects = await this.api.load();
      if (token === this.loadToken) {
        this.state.set({ kind: 'ready', projects });
      }
    } catch (error: unknown) {
      if (token === this.loadToken) {
        this.state.set({ kind: 'failed', failure: this.failureOf(error) });
      }
    } finally {
      if (token === this.loadToken) {
        this.reloading.set(false);
      }
    }
  }

  private failureOf(error: unknown): OverviewFailure {
    if (!(error instanceof HttpErrorResponse)) {
      // A bad response shape, or a bug: the generic failure, and the error handler gets the cause.
      if (!(error instanceof UnexpectedOverviewResponse)) {
        this.errors.handleError(error);
      }
      return 'unavailable';
    }
    const problem = httpProblemOf(error);
    if (problem.slug === 'github-rate-limit' || problem.status === 429) {
      return 'rate-limited';
    }
    return problem.status === 0 ? 'offline' : 'unavailable';
  }
}
