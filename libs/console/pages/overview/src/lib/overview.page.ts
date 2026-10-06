import { Dialog } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  ErrorHandler,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ADD_PROJECT_FRAGMENT,
  AnsweredItems,
  OverviewApi,
  ProjectsStore,
  UnexpectedOverviewResponse,
  type OverviewProject,
} from '@console/entities/project';
import { TeamStatusStore } from '@console/entities/team-run';
import { httpProblemOf } from '@console/shared/api';
import { TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, BREAKPOINTS, Button, Icon, Sheet, SrOnlyOnPhone, StateBlock } from '@console/shared/ui';
import {
  CommandsPane,
  CommandsSheet,
  isCommandsShortcut,
  type CommandsProject,
} from '@console/widgets/commands-panel';
import { GitHubRepositoriesBlock } from '@console/widgets/github-repositories';
import { NOT_SNOOZED, type SnoozeDto } from '@shared/contracts';
import { map } from 'rxjs';
import { OVERVIEW_PENDING_PROBLEM, OverviewTile } from './overview-tile';

/** A snooze that ends while the page is open loses its line within this. */
const SNOOZE_TICK_MS = 30_000;

export type OverviewFailure = 'rate-limited' | 'offline' | 'unavailable';

type OverviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly projects: readonly OverviewProject[] }
  | { readonly kind: 'failed'; readonly failure: OverviewFailure };

interface TileRow {
  readonly project: OverviewProject;
  readonly waiting: number;
  readonly snooze: SnoozeDto;
}

/**
 * `/overview` (#27, ADR 0001 decision 24): every active project at a glance, read-only, from one request. Projects
 * with something for the owner — or that could not be read — come first, the quiet ones below (Paper Desk
 * direction). Tapping a project opens its board. When the Worker's request budget left some projects unread, they
 * say so in their tile and "Load the rest" asks again; the Worker continues from its cache. Below the projects,
 * "Available on GitHub" (#194) lists the repositories to add from; every "Add project" entry point lands there.
 * Each card has its own Commands (#222): the same panel as the space's, a pane on a wide screen (K on a focused card
 * opens it for that card) and a bottom sheet on the phone; closing it returns focus to that card's button.
 */
@Component({
  selector: 'tc-overview-page',
  imports: [
    Banner,
    Button,
    CommandsPane,
    GitHubRepositoriesBlock,
    Icon,
    NgTemplateOutlet,
    OverviewTile,
    SrOnlyOnPhone,
    StateBlock,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './overview.page.html',
  styleUrl: './overview.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class OverviewPage {
  private readonly api = inject(OverviewApi);
  private readonly answered = inject(AnsweredItems);
  private readonly errors = inject(ErrorHandler);
  protected readonly projects = inject(ProjectsStore);
  private readonly repositories = viewChild.required(GitHubRepositoriesBlock);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly sheet = inject(Sheet);
  private readonly dialog = inject(Dialog);
  private readonly teamStatus = inject(TeamStatusStore);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly isPhone = toSignal(
    this.breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );
  protected readonly now = signal(Date.now());
  /** The card whose Commands pane is open on a wide screen. */
  protected readonly openSlug = signal<string | null>(null);

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
      // The registry list is the live copy: a snooze changed from the panel shows at once (#221's applySnooze).
      snooze:
        this.projects.bySlug(project.slug)?.snooze ??
        (project.kind === 'read' ? project.snooze : NOT_SNOOZED),
    }));
  });

  protected readonly paneProject = computed<CommandsProject | null>(() => {
    const slug = this.openSlug();
    const row = slug === null ? undefined : this.rows().find((candidate) => candidate.project.slug === slug);
    return row === undefined ? null : this.commandsProjectOf(row.project);
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
    const tick = setInterval(() => this.now.set(Date.now()), SNOOZE_TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
      clearInterval(tick);
    });
    effect(() => {
      if (this.isPhone()) {
        untracked(() => this.openSlug.set(null));
      }
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

  /** The card's Commands: the sheet on the phone; on a wide screen the pane, toggled, or moved to this card. */
  protected toggleCommands(row: OverviewProject): void {
    const project = this.commandsProjectOf(row);
    if (this.isPhone()) {
      void this.teamStatus.load(project.slug);
      // The sheet restores focus to the button that opened it.
      this.sheet.open(CommandsSheet, {
        title: this.transloco.translate('commands.title', { name: project.name }),
        data: project,
      });
      return;
    }
    if (this.openSlug() === project.slug) {
      this.closePane();
      return;
    }
    void this.teamStatus.load(project.slug);
    this.openSlug.set(project.slug);
    afterNextRender(() => this.query('.tc-commands-pane .cp__title')?.focus(), { injector: this.injector });
  }

  protected closePane(): void {
    const slug = this.openSlug();
    this.openSlug.set(null);
    if (slug !== null) {
      afterNextRender(() => this.query(`[data-commands-for="${CSS.escape(slug)}"]`)?.focus(), {
        injector: this.injector,
      });
    }
  }

  /**
   * On a wide screen K opens Commands for the card that holds focus (its link or its button), and closes the pane
   * from inside it; elsewhere on the page K is left alone. Escape closes the pane from inside.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (this.isPhone() || this.dialog.openDialogs.length > 0 || event.defaultPrevented) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const isInPane = Boolean(target?.closest('.tc-commands-pane'));
    if (event.key === 'Escape' && isInPane && this.openSlug() !== null) {
      event.preventDefault();
      this.closePane();
      return;
    }
    if (!isCommandsShortcut(event)) {
      return;
    }
    const slug = target?.closest('[data-card-slug]')?.getAttribute('data-card-slug') ?? null;
    const row = slug === null ? undefined : this.rows().find((candidate) => candidate.project.slug === slug);
    if (row !== undefined) {
      event.preventDefault();
      this.toggleCommands(row.project);
    } else if (isInPane && this.openSlug() !== null) {
      event.preventDefault();
      this.closePane();
    }
  }

  private commandsProjectOf(row: OverviewProject): CommandsProject {
    return { slug: row.slug, name: row.name, repo: this.projects.bySlug(row.slug)?.repo ?? '' };
  }

  private query(selector: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(selector);
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
        // The overview is the fresher read: the sidebar's bell follows it, and so do the cards.
        for (const project of projects) {
          if (project.kind === 'read') {
            this.projects.applySnooze(project.slug, project.snooze);
          }
        }
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
