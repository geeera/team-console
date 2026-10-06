import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { GitHubConnectionView } from '@console/entities/github-connection';
import {
  repositoryGroupsOf,
  type RepositoriesProblem,
  type RepositoriesStatus,
} from '@console/entities/installation-repository';
import { projectSetupRouteOf } from '@console/entities/project';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Button, Callout, Icon, List, ListRow, StateBlock } from '@console/shared/ui';
import type { InstallationRepositoryDto } from '@shared/contracts';

/** What a repository row shows while or after an add from this screen (in memory only). */
export type RepositoryRowState =
  | { readonly kind: 'checking' }
  /** Refused: `step` is the checklist step that is missing (1–3), `null` for any other refusal. */
  | { readonly kind: 'not-added'; readonly step: number | null };

type RefreshControl = 'repos-refresh' | 'repos-missing-refresh';

// A long list folds after ten addable rows when more than twelve would show (the #194 design).
const FOLD_AT = 10;
const FOLD_OVER = 12;

/**
 * "Available on GitHub" (#194) as a pure view: every state of the list through kit primitives, from inputs only.
 * Which rows can be added and what a registered one says come from the DTO; the container decides the rest. The
 * Connect callout of the not-connected state is projected (`[tc-repos-connect]`), "Add by name" is the default slot.
 */
@Component({
  selector: 'tc-repository-list-view',
  imports: [Button, Callout, Icon, List, ListRow, LocalTimePipe, StateBlock, TranslocoPipe],
  templateUrl: './repository-list-view.html',
  styleUrl: './repository-list-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepositoryListView {
  readonly connection = input.required<GitHubConnectionView>();
  readonly status = input.required<RepositoriesStatus>();
  readonly problem = input<RepositoriesProblem | null>(null);
  readonly repositories = input<readonly InstallationRepositoryDto[]>([]);
  /** Full names that stay among the addable rows after an add, so the row turns "Project" in place. */
  readonly keepInPlace = input<ReadonlySet<string>>(new Set());
  /** By lower-case full name. */
  readonly rowStates = input<Readonly<Record<string, RepositoryRowState>>>({});
  readonly partial = input(false);
  readonly selectionUrl = input<string | null>(null);
  readonly appName = input('team-console');
  readonly login = input<string | null>(null);
  readonly online = input(true);
  readonly loadedAt = input<string | null>(null);
  readonly refreshing = input(false);

  readonly add = output<InstallationRepositoryDto>();
  readonly seeWhy = output<InstallationRepositoryDto>();
  readonly retry = output<void>();
  readonly refresh = output<void>();

  private readonly injector = inject(Injector);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly root = viewChild.required<ElementRef<HTMLElement>>('root');

  protected readonly expanded = signal(false);
  private refreshControl: RefreshControl = 'repos-refresh';

  protected readonly needsConnect = computed(() => {
    const view = this.connection();
    return view === 'not-connected' || view === 'lost';
  });
  protected readonly isLoading = computed(
    () => this.connection() === 'loading' || this.status() === 'idle' || this.status() === 'loading',
  );
  protected readonly hasList = computed(() => this.status() === 'ready' && !this.needsConnect());
  protected readonly groups = computed(() => repositoryGroupsOf(this.repositories(), this.keepInPlace()));
  protected readonly isFolded = computed(() => !this.expanded() && this.groups().addable.length > FOLD_OVER);
  protected readonly shownAddable = computed(() => {
    const addable = this.groups().addable;
    return this.isFolded() ? addable.slice(0, FOLD_AT) : addable;
  });
  /**
   * #278: GitHub lists only the repositories the installation was given, so a missing one (often a private one) is
   * fixed on GitHub. The partial note and the empty state already carry that link.
   */
  protected readonly showsMissingStep = computed(() => !this.partial() && this.repositories().length > 0);
  protected readonly hiddenCount = computed(() => this.groups().addable.length - FOLD_AT);
  protected readonly rateTime = computed(() => {
    const problem = this.problem();
    return problem?.kind === 'rate' ? problem.retryAt : null;
  });
  protected readonly installUrl = computed(() => {
    const problem = this.problem();
    return problem?.kind === 'not-installed' ? problem.installUrl : null;
  });

  protected keyOf(repo: InstallationRepositoryDto): string {
    return repo.fullName.toLowerCase();
  }

  protected stateOf(repo: InstallationRepositoryDto): RepositoryRowState | null {
    return this.rowStates()[this.keyOf(repo)] ?? null;
  }

  protected missingStepOf(repo: InstallationRepositoryDto): number | null {
    const state = this.stateOf(repo);
    return state?.kind === 'not-added' ? state.step : null;
  }

  protected ownerOf(repo: InstallationRepositoryDto): string {
    return repo.fullName.split('/')[0] ?? '';
  }

  protected nameOf(repo: InstallationRepositoryDto): string {
    return repo.fullName.split('/')[1] ?? repo.fullName;
  }

  protected setupRouteOf(repo: InstallationRepositoryDto): readonly string[] | null {
    return repo.registration.state === 'active' ? projectSetupRouteOf(repo.registration.slug) : null;
  }

  protected onAdd(repo: InstallationRepositoryDto): void {
    // aria-disabled keeps the control focusable and announced; a tap on it does nothing (#194 UX spec §5).
    if (!this.online() || this.stateOf(repo)?.kind === 'checking') {
      return;
    }
    this.add.emit(repo);
  }

  protected onRefresh(control: RefreshControl = 'repos-refresh'): void {
    if (!this.online() || this.refreshing()) {
      return;
    }
    this.refreshControl = control;
    this.refresh.emit();
  }

  protected showMore(): void {
    this.expanded.set(true);
    // The first row that was folded away takes focus, so the keyboard continues where the list grew.
    afterNextRender(() => this.focusAddableAt(FOLD_AT), { injector: this.injector });
  }

  focusHeading(): void {
    this.heading().nativeElement.focus();
  }

  revealHeading(): void {
    const heading = this.heading().nativeElement;
    // Optional: jsdom (unit tests) has no layout and no scrollIntoView.
    heading.scrollIntoView?.({ block: 'start' });
    heading.focus({ preventScroll: true });
  }

  /** Focus a row's control: its link once it is a project, else its Add button. */
  focusRow(fullName: string): boolean {
    const row = this.root().nativeElement.querySelector<HTMLElement>(
      `[data-repo="${CSS.escape(fullName.toLowerCase())}"]`,
    );
    const target =
      row?.querySelector<HTMLElement>('a.tc-list-row__surface, [data-testid="repo-add"]') ?? null;
    target?.focus();
    return target !== null;
  }

  /** The control a refused add returns focus to, or the heading when the row is gone. */
  focusRetry(): void {
    const retry = this.root().nativeElement.querySelector<HTMLElement>('[data-testid="repos-retry"]');
    (retry ?? this.heading().nativeElement).focus();
  }

  /** Focus returns to the Refresh the owner pressed: the one in the head or the one in the missing step. */
  focusRefresh(): void {
    const root = this.root().nativeElement;
    const target =
      root.querySelector<HTMLElement>(`[data-testid="${this.refreshControl}"]`) ??
      root.querySelector<HTMLElement>('[data-testid="repos-refresh"]');
    target?.focus();
  }

  private focusAddableAt(index: number): void {
    const rows = this.root().nativeElement.querySelectorAll<HTMLElement>(
      '[data-group="addable"] tc-list-row',
    );
    rows[index]?.querySelector<HTMLElement>('button, a')?.focus();
  }
}
