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
  daysUntilDemo,
  demoDayOf,
  NO_STATUS,
  SprintApi,
  SprintBoard as SprintBoardModel,
  SprintItemList,
  STATUS_ORDER,
  statusColumnsOf,
  UnexpectedSprintResponse,
} from '@console/entities/sprint';
import { httpProblemOf } from '@console/shared/api';
import {
  localDayOf,
  localTimeOf,
  pluralKeyOf,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Button, Chip, Icon, Lane, Lanes, Stat, Stats, StateBlock } from '@console/shared/ui';

/** Without a usable `Retry-After` on a 429, the board waits this long before it asks again. */
export const DEFAULT_RETRY_SECONDS = 60;

export type BoardFailure = 'rate-limited' | 'not-installed' | 'offline' | 'unavailable';

type BoardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly board: SprintBoardModel }
  | { readonly kind: 'failed'; readonly failure: BoardFailure; readonly retryAt: number | null };

/** The project the board reads; the slug picks the read model, the name is for copy only. */
export interface SprintBoardProject {
  readonly slug: string;
  readonly name: string;
}

let nextBoardId = 0;

const KNOWN_STATUSES: ReadonlySet<string> = new Set([...STATUS_ORDER, NO_STATUS]);

/**
 * A project's current sprint, read-only (#18): the milestone and its demo date, the sprint's numbers, its issues in
 * status lanes with their tier, and the repository's open pull requests. Everything comes from one
 * `GET /api/v1/projects/:slug/sprint`; nothing here writes. Lanes are their own blocks so the later
 * current / next / backlog grouping (#108) can repeat them per section.
 */
@Component({
  selector: 'tc-sprint-board',
  imports: [Button, Chip, Icon, Lane, Lanes, SprintItemList, Stat, Stats, StateBlock, TranslocoPipe],
  templateUrl: './sprint-board.html',
  styleUrl: './sprint-board.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-sprint-board' },
})
export class SprintBoard {
  private readonly api = inject(SprintApi);
  private readonly transloco = inject(TranslocoService);
  private readonly errors = inject(ErrorHandler);

  readonly project = input.required<SprintBoardProject>();

  protected readonly titleId = `tc-sprint-board-title-${nextBoardId++}`;
  protected readonly state = signal<BoardState>({ kind: 'loading' });
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

  protected readonly retryTime = computed(() => {
    const retryAt = this.failure()?.retryAt ?? null;
    return retryAt === null ? '' : localTimeOf(retryAt, this.lang());
  });

  constructor() {
    effect(() => {
      const slug = this.project().slug;
      untracked(() => {
        this.state.set({ kind: 'loading' });
        void this.load(slug);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
      this.clearRetry();
    });
  }

  async reload(): Promise<void> {
    this.state.set({ kind: 'loading' });
    await this.load(this.project().slug);
  }

  protected laneName(status: string): string {
    this.lang();
    // An unknown `status:*` label is shown as written in the repository (plain text, like a title).
    return KNOWN_STATUSES.has(status) ? this.transloco.translate(`board.status.${status}`) : status;
  }

  private async load(slug: string): Promise<void> {
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
      this.state.set({ kind: 'failed', ...failed });
      if (failed.retryAt !== null) {
        // GitHub said when; ask again then, once, so the board comes back by itself.
        this.retryTimer = setTimeout(() => void this.reload(), Math.max(0, failed.retryAt - Date.now()));
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
      const seconds = problem.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
      return { failure: 'rate-limited', retryAt: Date.now() + seconds * 1000 };
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
