import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ErrorHandler,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ciSummaryOf,
  daysUntilDemo,
  demoDayOf,
  NO_STATUS,
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
  LocalNumberPipe,
  localTimeOf,
  pluralKeyOf,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Button, Chip, Icon, Lane, Lanes, Stat, Stats, StatTone, StateBlock, Toaster } from '@console/shared/ui';

/** Without a usable `Retry-After` on a 429 (missing, invalid or 0), the board waits this long before it asks again. */
export const DEFAULT_RETRY_SECONDS = 60;
/** Bounds on the automatic retry: never a tight loop, never past `setTimeout`'s range or an hour. */
export const MIN_RETRY_SECONDS = 5;
export const MAX_RETRY_SECONDS = 3600;

/** The wait before the automatic retry, from the 429's `Retry-After` seconds. */
export function retryDelaySeconds(retryAfter: number | null): number {
  if (retryAfter === null || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return DEFAULT_RETRY_SECONDS;
  }
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, retryAfter));
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

/**
 * A project's current sprint, read-only (#18): the milestone and its demo date, the sprint's numbers, its issues in
 * status lanes with their tier, the repository's open pull requests with their CI (#131), and the team's run state
 * with its last five runs (#132). Everything comes from one
 * `GET /api/v1/projects/:slug/sprint`; nothing here writes. Lanes are their own blocks so the later
 * current / next / backlog grouping (#108) can repeat them per section.
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
    SprintItemList,
    SprintRunList,
    SprintTierIcon,
    Stat,
    Stats,
    StateBlock,
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

  readonly project = input.required<SprintBoardProject>();

  protected readonly titleId = `tc-sprint-board-title-${nextBoardId++}`;
  protected readonly state = signal<BoardState>({ kind: 'loading' });
  protected readonly tiers = SPRINT_TIERS;
  /** The lane shown on the phone; kept here so a refresh (Retry, the 429 retry) keeps the owner's lane. */
  protected readonly selectedLane = signal<string | null>(null);
  /** The Move demo dialog is open or its answer is on its way: a second press waits. */
  protected readonly isMovingDemo = signal(false);
  /** The Ask the PM picker or form is open: a second press waits. */
  protected readonly isAsking = signal(false);
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });
  private loadToken = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly board = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.board : null;
  });
  protected readonly columns = computed(() => statusColumnsOf(this.board()?.issues ?? []));
  /** The "CI" tile (#131): the most urgent state across the open pull requests. */
  protected readonly ci = computed(() => ciSummaryOf(this.board()?.pullRequests ?? []));
  protected readonly ciIcon = computed(() => SPRINT_CI_ICONS[this.ci().state]);
  protected readonly ciTone = computed((): StatTone => {
    const state = this.ci().state;
    return state === 'failure' ? 'danger' : state === 'success' ? 'success' : 'neutral';
  });
  /** The "Run log" tile (#132): the team as the plugin's `runstate` reads the run log. */
  protected readonly teamIcon = computed(() => TEAM_RUN_ICONS[this.board()?.team.state ?? 'unknown']);
  protected readonly teamTone = computed((): StatTone => {
    const state = this.board()?.team.state;
    return state === 'failing' ? 'danger' : state === 'running' ? 'success' : 'neutral';
  });
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
        this.state.set({ kind: 'loading' });
        void this.load(slug, true);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
      this.clearRetry();
    });
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
