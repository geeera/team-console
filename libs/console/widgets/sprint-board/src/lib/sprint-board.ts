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
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { NeedsYouCounts, spaceUrlOf } from '@console/entities/project';
import {
  ciSummaryOf,
  daysUntilDemo,
  demoDayOf,
  NO_STATUS,
  pullsByUrgency,
  SprintApi,
  SPRINT_CI_ICONS,
  SprintBoard as SprintBoardModel,
  SprintItemList,
  SprintRunList,
  SPRINT_TIERS,
  SprintTierIcon,
  STATUS_ORDER,
  statusColumnsOf,
  TEAM_RUN_ICONS,
  UnexpectedSprintResponse,
} from '@console/entities/sprint';
import { RequestChange } from '@console/features/request-change';
import { SprintControls } from '@console/features/sprint-controls';
import { httpProblemOf } from '@console/shared/api';
import {
  localDayOf,
  localNumberOf,
  LocalNumberPipe,
  localTimeOf,
  pluralKeyOf,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import {
  BREAKPOINTS,
  Button,
  Chip,
  Icon,
  Lane,
  markArrival,
  type Arrival,
  Lanes,
  Stat,
  Stats,
  StatTone,
  StateBlock,
  TabPanel,
  Tabs,
  Toaster,
} from '@console/shared/ui';
import { map } from 'rxjs';

/** Without a usable `Retry-After` on a 429 (missing, invalid or 0), the board waits this long before it asks again. */
export const DEFAULT_RETRY_SECONDS = 60;
/** Bounds on the automatic retry: never a tight loop, never past `setTimeout`'s range or an hour. */
export const MIN_RETRY_SECONDS = 5;
export const MAX_RETRY_SECONDS = 3600;

/** Rows a list shows before «Show N more» (#275 §3). */
export const BOARD_LIST_LIMIT = 5;

/** The board's sections on a narrow screen; also the `?tab=` values (`tasks` is the default and needs none). */
export const BOARD_TABS = ['tasks', 'pr', 'runs'] as const;
export type BoardTab = (typeof BOARD_TABS)[number];

export function isBoardTab(value: unknown): value is BoardTab {
  return typeof value === 'string' && (BOARD_TABS as readonly string[]).includes(value);
}

/** The lane a narrow screen opens on: the blockers when there are any, else the work in progress (#275 §3). */
export const PREFERRED_LANES: readonly string[] = ['blocked', 'in-progress'];

/**
 * How the status tiles sit (#275, #294), by the board's own width (the Commands pane beside it takes room too):
 * `auto` on a narrow screen (2×2, one column at large text), else as many as keep «1 PR не прошёл» whole —
 * five in a row, four in a row (open items under Done), or 2×2.
 */
export type TileLayout = 'auto' | 'five' | 'four' | 'two';

/** Narrowest board for five tiles in a row, and for four: every tile keeps about 180 px. */
export const FIVE_TILES_MIN_WIDTH = 932;
export const FOUR_TILES_MIN_WIDTH = 744;

export function tileLayoutOf(boardWidth: number | null, isCompact: boolean): TileLayout {
  if (isCompact) {
    return 'auto';
  }
  if (boardWidth === null || boardWidth >= FIVE_TILES_MIN_WIDTH) {
    return 'five';
  }
  return boardWidth >= FOUR_TILES_MIN_WIDTH ? 'four' : 'two';
}

const TILE_COLUMNS: Readonly<Record<TileLayout, number | null>> = { auto: null, five: 5, four: 4, two: 2 };

/** The wait before the automatic retry, from the 429's `Retry-After` seconds. */
export function retryDelaySeconds(retryAfter: number | null): number {
  if (retryAfter === null || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return DEFAULT_RETRY_SECONDS;
  }
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, retryAfter));
}

/** The first `BOARD_LIST_LIMIT` items, or all of them once expanded. */
export function visibleItemsOf<T>(items: readonly T[], isExpanded: boolean): readonly T[] {
  return isExpanded ? items : items.slice(0, BOARD_LIST_LIMIT);
}

/** How many rows «Show N more» would add; 0 means the list needs no button. */
export function hiddenCountOf(items: readonly unknown[]): number {
  return Math.max(0, items.length - BOARD_LIST_LIMIT);
}

export type BoardFailure = 'rate-limited' | 'not-installed' | 'offline' | 'unavailable';

type BoardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly board: SprintBoardModel }
  | {
      readonly kind: 'failed';
      readonly failure: BoardFailure;
      /** When the automatic retry fires; `null` when none is scheduled (then only Retry is offered). */
      readonly retryAt: number | null;
    };

/** The project the board reads; the slug picks the read model, the name is for copy only. */
export interface SprintBoardProject {
  readonly slug: string;
  readonly name: string;
}

let nextBoardId = 0;

const KNOWN_STATUSES: ReadonlySet<string> = new Set([...STATUS_ORDER, NO_STATUS]);

/** The list a tile jumps to. */
type TileTarget = 'pulls' | 'runs' | 'questions';

/**
 * A project's current sprint, read-only (#18), laid out so the key status is on the first screen (#275): the sprint
 * title and demo date, then status tiles (done, CI, runs, «waiting for you» — the last three jump to their list), then
 * the issues by lane, the open pull requests (#131) and the team's last runs (#132). Below the tablet breakpoint the
 * three lists are tabs; above it they are two columns (laid out by the board's container width). Every list shows
 * `BOARD_LIST_LIMIT` rows, then «Show N more». Everything comes from one `GET /api/v1/projects/:slug/sprint`, plus
 * the «waiting for you» count the shell already polls; nothing here writes.
 */
@Component({
  selector: 'tc-sprint-board',
  imports: [
    Button,
    Chip,
    Icon,
    Lane,
    Lanes,
    LocalNumberPipe,
    NgTemplateOutlet,
    SprintItemList,
    SprintRunList,
    SprintTierIcon,
    Stat,
    Stats,
    StateBlock,
    TabPanel,
    Tabs,
    TranslocoPipe,
  ],
  templateUrl: './sprint-board.html',
  styleUrl: './sprint-board.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-sprint-board' },
})
export class SprintBoard {
  private readonly api = inject(SprintApi);
  private readonly transloco = inject(TranslocoService);
  private readonly errors = inject(ErrorHandler);
  private readonly sprintControls = inject(SprintControls);
  private readonly requestChange = inject(RequestChange);
  private readonly toaster = inject(Toaster);
  private readonly router = inject(Router);
  private readonly needsYou = inject(NeedsYouCounts);
  private readonly persisted = inject(PersistedStateStore);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly project = input.required<SprintBoardProject>();
  /** The `?tab=` of a deep link; anything but a `BoardTab` is ignored. */
  readonly initialTab = input<string | null>(null);

  protected readonly titleId = `tc-sprint-board-title-${nextBoardId++}`;
  protected readonly state = signal<BoardState>({ kind: 'loading' });
  protected readonly tiers = SPRINT_TIERS;
  protected readonly preferredLanes = PREFERRED_LANES;
  protected readonly limit = BOARD_LIST_LIMIT;
  /** The lane shown on a narrow screen; kept here so a refresh (Retry, the 429 retry) keeps the owner's lane. */
  protected readonly selectedLane = signal<string | null>(null);
  protected readonly tab = signal<BoardTab>('tasks');
  /** Lists opened past their first rows («lane:<status>», «pulls»), and «done» once its folded lane is shown. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** The Move demo dialog is open or its answer is on its way: a second press waits. */
  protected readonly isMovingDemo = signal(false);
  /** The Ask the PM picker or form is open: a second press waits. */
  protected readonly isAsking = signal(false);
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });
  /** Below the tablet breakpoint the board is the iPhone layout: four tiles, the lists as tabs (#275 §3). */
  protected readonly compact = toSignal(
    this.breakpoints.observe(BREAKPOINTS.tablet).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.tablet) },
  );
  /** The board's own width; `null` until measured (and where `ResizeObserver` is missing). */
  private readonly width = signal<number | null>(null);
  protected readonly tileLayout = computed(() => tileLayoutOf(this.width(), this.compact()));
  protected readonly tileColumns = computed(() => TILE_COLUMNS[this.tileLayout()]);
  private readonly tabs = viewChild(Tabs);
  private readonly pullsHeading = viewChild<ElementRef<HTMLElement>>('pullsHeading');
  private readonly runsHeading = viewChild<ElementRef<HTMLElement>>('runsHeading');
  private ring: Arrival | null = null;
  private loadToken = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly board = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.board : null;
  });
  protected readonly columns = computed(() => statusColumnsOf(this.board()?.issues ?? []));
  protected readonly pulls = computed(() => pullsByUrgency(this.board()?.pullRequests ?? []));
  protected readonly visiblePulls = computed(() => visibleItemsOf(this.pulls(), this.isExpanded('pulls')));
  /** The "CI" tile (#131): the most urgent state across the open pull requests. */
  protected readonly ci = computed(() => ciSummaryOf(this.board()?.pullRequests ?? []));
  protected readonly ciIcon = computed(() => SPRINT_CI_ICONS[this.ci().state]);
  protected readonly ciTone = computed((): StatTone => {
    const state = this.ci().state;
    return state === 'failure' ? 'danger' : state === 'success' ? 'success' : 'neutral';
  });
  protected readonly ciValue = computed(() => {
    const lang = this.lang();
    const { state, count } = this.ci();
    const key = `board.ci.summary.${state}`;
    const params = { n: localNumberOf(count, lang) };
    return this.transloco.translate(state === 'failure' ? pluralKeyOf(key, lang, count) : key, params);
  });
  /** The "Run log" tile (#132): the team as the plugin's `runstate` reads the run log. */
  protected readonly teamIcon = computed(() => TEAM_RUN_ICONS[this.board()?.team.state ?? 'unknown']);
  protected readonly teamTone = computed((): StatTone => {
    const state = this.board()?.team.state;
    return state === 'failing' ? 'danger' : state === 'running' ? 'success' : 'neutral';
  });
  protected readonly teamValue = computed(() => {
    this.lang();
    return this.transloco.translate(`board.team.${this.board()?.team.state ?? 'unknown'}`);
  });
  /** «Waiting for you»: the count the shell's badge shows; `null` until the first read answered. */
  protected readonly waiting = computed(() =>
    this.needsYou.refreshedAt() === null ? null : this.needsYou.countOf(this.project().slug),
  );
  protected readonly waitingValue = computed(() => {
    const lang = this.lang();
    const count = this.waiting();
    if (count === null) {
      return this.transloco.translate('board.stat.waitingUnknown');
    }
    if (count === 0) {
      return this.transloco.translate('board.stat.waitingNone');
    }
    return this.transloco.translate(pluralKeyOf('board.stat.waitingValue', lang, count), {
      n: localNumberOf(count, lang),
    });
  });
  protected readonly ciAria = computed(() => this.tileAria('board.stat.ci', this.ciValue(), 'pulls'));
  protected readonly teamAria = computed(() => this.tileAria('board.stat.runs', this.teamValue(), 'runs'));
  protected readonly waitingAria = computed(() =>
    this.tileAria('board.stat.waiting', this.waitingValue(), 'questions'),
  );
  protected readonly failure = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? state : null;
  });

  protected readonly demoLine = computed(() => {
    const lang = this.lang();
    const milestone = this.board()?.milestone;
    if (milestone === null || milestone === undefined) {
      return '';
    }
    const date = localDayOf(demoDayOf(milestone.dueOn), lang);
    const days = daysUntilDemo(milestone.dueOn, new Date());
    if (days === 0) {
      return this.transloco.translate('board.demoToday', { date });
    }
    if (days > 0) {
      return this.transloco.translate(pluralKeyOf('board.demoIn', lang, days), { date, n: days });
    }
    return this.transloco.translate('board.demo', { date });
  });

  /** A 429 without a scheduled retry must not promise one. */
  protected readonly failureHintKey = computed(() => {
    const failed = this.failure();
    if (failed === null) {
      return '';
    }
    const manual = failed.failure === 'rate-limited' && failed.retryAt === null;
    return `board.error.${failed.failure}.${manual ? 'hintManual' : 'hint'}`;
  });

  protected readonly retryTime = computed(() => {
    const retryAt = this.failure()?.retryAt ?? null;
    return retryAt === null ? '' : localTimeOf(retryAt, this.lang());
  });

  constructor() {
    effect(() => {
      const slug = this.project().slug;
      untracked(() => {
        this.selectedLane.set(null);
        this.expanded.set(new Set());
        const remembered = this.persisted.projectState(slug)?.boardTab;
        this.tab.set(isBoardTab(remembered) ? remembered : 'tasks');
        this.state.set({ kind: 'loading' });
        void this.load(slug, true);
      });
    });
    // A deep link's tab wins over the remembered one.
    effect(() => {
      const wanted = this.initialTab();
      if (isBoardTab(wanted)) {
        untracked(() => this.tab.set(wanted));
      }
    });
    let observer: ResizeObserver | null = null;
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      observer = new ResizeObserver(([entry]) => {
        if (entry !== undefined) {
          this.width.set(Math.round(entry.contentRect.width));
        }
      });
      observer.observe(this.host.nativeElement);
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      this.ring?.clear();
      this.loadToken += 1;
      this.clearRetry();
    });
  }

  protected isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }

  protected toggle(key: string): void {
    this.expanded.update((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  protected visible<T>(items: readonly T[], key: string): readonly T[] {
    return visibleItemsOf(items, this.isExpanded(key));
  }

  protected hidden(items: readonly unknown[]): number {
    return hiddenCountOf(items);
  }

  /** Done is folded to its heading on a wide screen until shown (#275 §3); the switcher already hides it on a narrow one. */
  protected isFolded(status: string): boolean {
    return status === 'done' && !this.compact() && !this.isExpanded('done');
  }

  protected onTab(key: string | null): void {
    if (!isBoardTab(key)) {
      return;
    }
    this.tab.set(key);
    this.persisted.setBoardTab(this.project().slug, key);
  }

  /**
   * A tile's jump (#275 §6): on a narrow screen its tab opens and focus moves into the panel; on a wide one the list scrolls
   * into view if needed, gets the arrival ring and focus moves to its heading.
   */
  protected jumpTo(target: 'pr' | 'runs'): void {
    if (this.compact()) {
      this.onTab(target);
      this.tabs()?.select(target, { focusPanel: true });
      return;
    }
    const heading = (target === 'pr' ? this.pullsHeading() : this.runsHeading())?.nativeElement;
    if (heading === undefined) {
      return;
    }
    // The list is often on screen already: the ring (as for a #n deep link) is what says the tap did something.
    this.ring?.clear();
    this.ring = markArrival(heading.closest<HTMLElement>('tc-tab-panel') ?? heading, heading);
  }

  protected openQuestions(): void {
    void this.router.navigateByUrl(spaceUrlOf(this.project().slug, 'questions'));
  }

  /**
   * "Move demo" by the sprint title (#218): the Commands panel's dialog, answered with a toast because the panel and
   * its result note are not on screen; the board reads the sprint again once the date moved.
   */
  protected async moveDemo(): Promise<void> {
    if (this.isMovingDemo()) {
      return;
    }
    this.isMovingDemo.set(true);
    try {
      const outcome = await this.sprintControls.moveDemo({
        slug: this.project().slug,
        name: this.project().name,
      });
      if (outcome === null) {
        return;
      }
      this.toaster.show([outcome.verb, outcome.detail].filter((text) => text !== null).join('. '));
      await this.load(this.project().slug, true);
    } finally {
      this.isMovingDemo.set(false);
    }
  }

  /**
   * "Ask the PM" (#219): the Commands panel's picker and form, answered with a toast; the board reads the sprint again
   * so the row shows «waiting for the PM».
   */
  protected async askPm(): Promise<void> {
    if (this.isAsking()) {
      return;
    }
    this.isAsking.set(true);
    try {
      const outcome = await this.requestChange.ask({ slug: this.project().slug, name: this.project().name });
      if (outcome === null) {
        return;
      }
      this.toaster.show([outcome.verb, outcome.detail].filter((text) => text !== null).join('. '));
      await this.load(this.project().slug, true);
    } finally {
      this.isAsking.set(false);
    }
  }

  /** Retry: the owner's action, so it may earn one more automatic retry. */
  async reload(): Promise<void> {
    await this.retry(true);
  }

  protected laneName(status: string): string {
    this.lang();
    // An unknown `status:*` label is shown as written in the repository (plain text, like a title).
    return KNOWN_STATUSES.has(status) ? this.transloco.translate(`board.status.${status}`) : status;
  }

  private tileAria(labelKey: string, value: string, target: TileTarget): string {
    this.lang();
    return this.transloco.translate('board.tile.openAria', {
      label: this.transloco.translate(labelKey),
      value,
      target: this.transloco.translate(`board.tile.target.${target}`),
    });
  }

  private async retry(mayAutoRetry: boolean): Promise<void> {
    this.state.set({ kind: 'loading' });
    await this.load(this.project().slug, mayAutoRetry);
  }

  /** `mayAutoRetry`: a 429 schedules one automatic retry, which itself may not schedule another. */
  private async load(slug: string, mayAutoRetry: boolean): Promise<void> {
    const token = ++this.loadToken;
    this.clearRetry();
    try {
      const board = await this.api.current(slug);
      if (token === this.loadToken) {
        this.state.set({ kind: 'ready', board });
      }
    } catch (error: unknown) {
      if (token !== this.loadToken) {
        return;
      }
      const failed = this.failureOf(error);
      const retryAt = mayAutoRetry ? failed.retryAt : null;
      this.state.set({ kind: 'failed', failure: failed.failure, retryAt });
      if (retryAt !== null) {
        // At most one automatic retry per load or Retry tap; a second 429 leaves only the Retry button.
        this.retryTimer = setTimeout(() => void this.retry(false), retryAt - Date.now());
      }
    }
  }

  private failureOf(error: unknown): { failure: BoardFailure; retryAt: number | null } {
    if (!(error instanceof HttpErrorResponse)) {
      // A bad response shape, or a bug: the board shows the generic failure and the error handler gets the cause.
      if (!(error instanceof UnexpectedSprintResponse)) {
        this.errors.handleError(error);
      }
      return { failure: 'unavailable', retryAt: null };
    }
    const problem = httpProblemOf(error);
    if (problem.slug === 'github-rate-limit' || problem.status === 429) {
      return {
        failure: 'rate-limited',
        retryAt: Date.now() + retryDelaySeconds(problem.retryAfterSeconds) * 1000,
      };
    }
    if (problem.slug === 'github-app-not-installed') {
      return { failure: 'not-installed', retryAt: null };
    }
    if (problem.status === 0) {
      return { failure: 'offline', retryAt: null };
    }
    return { failure: 'unavailable', retryAt: null };
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
