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
import { AnsweredItem, AnsweredItems, answeredKeyOf } from '@console/entities/project';
import {
  QuestionCard,
  QuestionItem,
  QuestionProjectProblem,
  QuestionsApi,
  safeGitHubUrl,
} from '@console/entities/question';
import { AnswerGiven, AnswerQuestion } from '@console/features/answer-question';
import { localTimeOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, CardStamp, Receipt, StateBlock } from '@console/shared/ui';
import type { AnswerCommand, NeedsYouProjectRef } from '@shared/contracts';
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
  imports: [AnswerQuestion, Button, QuestionCard, Receipt, StateBlock, TranslocoPipe],
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

  /** One project's questions; without it, every active project's. */
  readonly project = input<NeedsYouProjectRef | null>(null);

  protected readonly state = signal<LoadState>('loading');
  private readonly items = signal<readonly QuestionItem[]>([]);
  protected readonly problems = signal<readonly QuestionProjectProblem[]>([]);
  protected readonly omitted = signal<readonly NeedsYouProjectRef[]>([]);
  private readonly stamping = signal<ReadonlySet<string>>(new Set());
  protected readonly announcement = signal('');
  protected readonly refreshFailed = signal(false);
  private loadToken = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  protected readonly isAllProjects = computed(() => this.project() === null);
  protected readonly rows = computed<Row[]>(() =>
    this.items().map((item) => {
      const key = answeredKeyOf(item.project.slug, item.number);
      return {
        key,
        item,
        answer: this.answeredItems.get(item.project.slug, item.number) ?? null,
        stamping: this.stamping().has(key),
      };
    }),
  );
  protected readonly waiting = computed(() => this.rows().filter((row) => row.answer === null));
  protected readonly projectCount = computed(
    () => new Set(this.waiting().map((row) => row.item.project.slug)).size,
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
    inject(DestroyRef).onDestroy(() => {
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
        this.omitted.set(view.omitted);
        this.answeredItems.reconcile(view.readSlugs, this.refsOf(view.items));
      } else {
        const items = await this.api.projectQuestions(project);
        if (token !== this.loadToken) {
          return;
        }
        this.items.set(items);
        this.problems.set([]);
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
