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
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AnsweredItem, AnsweredItems, answeredKeyOf, ProjectsStore } from '@console/entities/project';
import type { QuestionArrival } from '@console/entities/push';
import {
  githubIssueUrlOf,
  QuestionCard,
  QuestionItem,
  QuestionProjectProblem,
  QuestionProjectSetup,
  QuestionsApi,
  safeGitHubUrl,
} from '@console/entities/question';
import { AnswerGiven, AnswerQuestion } from '@console/features/answer-question';
import { localTimeOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import {
  type Arrival,
  Banner,
  Button,
  Callout,
  CardStamp,
  Icon,
  markArrival,
  Receipt,
  StateBlock,
} from '@console/shared/ui';
import type { AnswerCommand, NeedsYouProjectRef, Section } from '@shared/contracts';
import { problemSlugOf } from '@shared/contracts';

/** How long the ink stamp shows on an answered card before it folds into its receipt (ADR 0002). */
export const STAMP_HOLD_MS = 900;

const KNOWN_PROBLEMS: ReadonlySet<string> = new Set([
  'github-app-not-installed',
  'project-config-invalid',
  'github-rate-limit',
]);

const TONES: Readonly<Record<AnswerCommand, CardStamp>> = {
  approve: 'positive',
  go: 'positive',
  override: 'positive',
  done: 'neutral',
  reject: 'negative',
  'no-go': 'negative',
};

type LoadState = 'loading' | 'ready' | 'error';

interface Row {
  readonly key: string;
  readonly item: QuestionItem;
  /** Set once the owner answered from this device; while `stamping`, the card still shows with the stamp. */
  readonly answer: AnsweredItem | null;
  readonly stamping: boolean;
}

/**
 * The owner's waiting items as answerable cards: every active project's ("Needs you", no `project`) or one
 * project's (its Questions section), in the read model's order — inbox order, then project, then number. An
 * answered card is stamped, then folds into a receipt that stays while GitHub still lists the issue.
 */
@Component({
  selector: 'tc-question-list',
  imports: [
    AnswerQuestion,
    Banner,
    Button,
    Callout,
    Icon,
    QuestionCard,
    Receipt,
    RouterLink,
    StateBlock,
    TranslocoPipe,
  ],
  templateUrl: './question-list.html',
  styleUrl: './question-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-question-list' },
})
export class QuestionList {
  private readonly api = inject(QuestionsApi);
  private readonly answeredItems = inject(AnsweredItems);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly projects = inject(ProjectsStore);

  /** One project's questions; without it, every active project's. */
  readonly project = input<NeedsYouProjectRef | null>(null);
  /** The item a notification opened (#36): scrolled to, ringed and focused once the list is shown. */
  readonly arrival = input<QuestionArrival | null>(null);
  /** Only these inbox sections (the Designs and demo screen, #20); `null` lists every section. */
  readonly sections = input<readonly Section[] | null>(null);
  /** Passed to every card: set, bodies render as sanitised markdown with a preview (#20). */
  readonly embedOrigins = input<readonly string[] | null>(null);
  /** Copy for a screen that lists a subset; already translated. Empty strings keep the Questions copy. */
  readonly listLabel = input('');
  readonly emptyTitle = input('');
  readonly emptyHint = input('');

  protected readonly state = signal<LoadState>('loading');
  private readonly items = signal<readonly QuestionItem[]>([]);
  protected readonly problems = signal<readonly QuestionProjectProblem[]>([]);
  protected readonly setups = signal<readonly QuestionProjectSetup[]>([]);
  protected readonly omitted = signal<readonly NeedsYouProjectRef[]>([]);
  private readonly stamping = signal<ReadonlySet<string>>(new Set());
  protected readonly announcement = signal('');
  protected readonly refreshFailed = signal(false);
  /** The number a notification led to that the list no longer has (answered or closed on GitHub meanwhile). */
  protected readonly goneNumber = signal<number | null>(null);
  protected readonly goneUrl = computed(() => {
    const number = this.goneNumber();
    const project = this.project();
    if (number === null || project === null) {
      return null;
    }
    const answered = this.answeredItems.get(project.slug, number);
    const repo = this.projects.bySlug(project.slug)?.repo;
    return (
      safeGitHubUrl(answered?.url ?? null) ?? (repo === undefined ? null : githubIssueUrlOf(repo, number))
    );
  });
  private handledArrival: number | null = null;
  private ring: Arrival | null = null;
  private loadToken = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  protected readonly isAllProjects = computed(() => this.project() === null);
  private readonly shownItems = computed(() => {
    const sections = this.sections();
    const items = this.items();
    return sections === null ? items : items.filter((item) => sections.includes(item.section));
  });
  protected readonly rows = computed<Row[]>(() =>
    this.shownItems().flatMap((item) => {
      const key = answeredKeyOf(item.project.slug, item.number);
      const answer = this.answeredItems.get(item.project.slug, item.number) ?? null;
      // Approved in a batch (#220): the card leaves the list; the batch's own receipt says what happened.
      if (answer?.batch === true) {
        return [];
      }
      return [{ key, item, answer, stamping: this.stamping().has(key) }];
    }),
  );
  protected readonly waiting = computed(() => this.rows().filter((row) => row.answer === null));
  /** The items still waiting for an answer from this device, once the list is read (the batch entry reads them). */
  readonly waitingItems = computed<readonly QuestionItem[]>(() =>
    this.state() === 'ready' ? this.waiting().map((row) => row.item) : [],
  );
  /** Projects that need the owner outside a card: a setup to finish, or an inbox that could not be read (#205). */
  protected readonly attentionCount = computed(() => this.setups().length + this.problems().length);
  /** The lead's project count: projects with a waiting card and projects with a row above the cards alike. */
  protected readonly projectCount = computed(
    () =>
      new Set([
        ...this.waiting().map((row) => row.item.project.slug),
        ...this.setups().map((setup) => setup.project.slug),
        ...this.problems().map((problem) => problem.project.slug),
      ]).size,
  );
  protected readonly omittedNames = computed(() =>
    this.omitted()
      .map((project) => project.name)
      .join(', '),
  );

  constructor() {
    effect(() => {
      const project = this.project();
      untracked(() => {
        this.items.set([]);
        this.state.set('loading');
        void this.load(project);
      });
    });
    effect(() => {
      const arrival = this.arrival();
      if (arrival === null || this.state() !== 'ready' || arrival.id === this.handledArrival) {
        return;
      }
      untracked(() => {
        this.handledArrival = arrival.id;
        this.arrive(arrival.number);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.ring?.clear();
      this.loadToken += 1;
      this.timers.forEach((timer) => clearTimeout(timer));
    });
  }

  async reload(): Promise<void> {
    await this.load(this.project());
  }

  protected toneOf(command: AnswerCommand): CardStamp {
    return TONES[command];
  }

  protected receiptUrl(answer: AnsweredItem): string | null {
    return safeGitHubUrl(answer.url);
  }

  protected timeOf(answer: AnsweredItem): string {
    return localTimeOf(answer.answeredAt, this.transloco.getActiveLang());
  }

  protected verbOf(command: AnswerCommand): string {
    return this.transloco.translate(`answer.command.${command}`);
  }

  protected problemReason(problem: QuestionProjectProblem): string {
    const slug = problemSlugOf(problem.problem.type) ?? problem.problem.type;
    return this.transloco.translate(`questions.problem.${KNOWN_PROBLEMS.has(slug) ? slug : 'other'}`);
  }

  protected settingsLinkOf(slug: string): readonly string[] {
    return ['/settings/projects', slug];
  }

  protected onAnswered({ item, response }: AnswerGiven): void {
    const key = answeredKeyOf(item.project.slug, item.number);
    const page = this.host.nativeElement.ownerDocument;
    const active = page.activeElement;
    const rowElement = this.host.nativeElement.querySelector(`[data-row="${CSS.escape(key)}"]`);
    // Focus inside the card (or already dropped to the page by a removed control) continues from the receipt.
    const hadFocus = active === null || active === page.body || (rowElement?.contains(active) ?? false);
    this.announcement.set(
      this.transloco.translate('answer.announce', { n: item.number, verb: this.verbOf(response.command) }),
    );
    this.stamping.update((keys) => new Set(keys).add(key));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.stamping.update((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
      if (hadFocus) {
        // The card and its focused button are gone; keyboard users continue from the receipt.
        afterNextRender(
          () =>
            this.host.nativeElement
              .querySelector<HTMLElement>(`[data-receipt="${CSS.escape(key)}"]`)
              ?.focus(),
          { injector: this.injector },
        );
      }
    }, STAMP_HOLD_MS);
    this.timers.add(timer);
  }

  /**
   * A notification's item: its card (focus on the title), its receipt when answered from here, or a note that it
   * no longer waits. This overrides the shell's scroll restore, which leaves a screen opened with a fragment alone.
   */
  private arrive(number: number): void {
    const row = this.rows().find((candidate) => candidate.item.number === number);
    this.goneNumber.set(row === undefined ? number : null);
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        let target: HTMLElement | null;
        let focus: HTMLElement | null;
        if (row === undefined) {
          target = focus = host.querySelector<HTMLElement>('[data-testid="push-gone"]');
        } else {
          const element = host.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.key)}"]`);
          const receipt = element?.querySelector<HTMLElement>('tc-receipt') ?? null;
          target = receipt ?? element?.querySelector<HTMLElement>('tc-card') ?? null;
          focus = receipt ?? element?.querySelector<HTMLElement>('[tc-card-title]') ?? null;
        }
        if (target !== null && focus !== null) {
          this.ring?.clear();
          this.ring = markArrival(target, focus);
        }
      },
      { injector: this.injector },
    );
  }

  private async load(project: NeedsYouProjectRef | null): Promise<void> {
    const token = ++this.loadToken;
    this.refreshFailed.set(false);
    try {
      if (project === null) {
        const view = await this.api.needsYou();
        if (token !== this.loadToken) {
          return;
        }
        this.items.set(view.items);
        this.problems.set(view.problems);
        this.setups.set(view.setups);
        this.omitted.set(view.omitted);
        this.answeredItems.reconcile(view.readSlugs, this.refsOf(view.items));
      } else {
        const items = await this.api.projectQuestions(project);
        if (token !== this.loadToken) {
          return;
        }
        this.items.set(items);
        this.problems.set([]);
        this.setups.set([]);
        this.omitted.set([]);
        this.answeredItems.reconcile([project.slug], this.refsOf(items));
      }
      this.state.set('ready');
    } catch {
      // HttpErrorResponse or an unexpected shape alike: the list shows the shared error block, the log has the request.
      if (token !== this.loadToken) {
        return;
      }
      // A failed refresh keeps the cards it showed and says so; with nothing shown yet the error block says why.
      const hasItems = this.items().length > 0;
      this.state.set(hasItems ? 'ready' : 'error');
      this.refreshFailed.set(hasItems);
    }
  }

  private refsOf(items: readonly QuestionItem[]): { slug: string; number: number }[] {
    return items.map((item) => ({ slug: item.project.slug, number: item.number }));
  }
}
