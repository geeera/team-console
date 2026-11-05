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
} from '@angular/core';
import type { QuestionItem } from '@console/entities/question';
import { QuestionCard } from '@console/entities/question';
import { AnswerQuestion, type AnswerGiven } from '@console/features/answer-question';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Receipt } from '@console/shared/ui';
import { ANSWERS, isTeamRecommendation, sectionOf } from '@shared/owner-grammar';
import type { AnswerCommand, AskDto, ItemDto } from '@shared/contracts';

const NEGATIVE: ReadonlySet<AnswerCommand> = new Set(['reject', 'no-go']);

/**
 * The item as a decision card (#16's, on the task screen): what it waits for from the open console ask, else the
 * section's own answers; `null` when the item waits for nothing. An imported item stays untrusted (R7).
 */
export function decisionItemOf(
  project: { readonly slug: string; readonly name: string },
  item: ItemDto,
  asks: readonly AskDto[],
): QuestionItem | null {
  if (item.state === 'closed') {
    return null;
  }
  const section = sectionOf(item.labels, item.kind);
  if (section === null) {
    return null;
  }
  const open = asks.find((ask) => ask.state === 'open' && ask.source === 'console') ?? null;
  const grammar = ANSWERS[section];
  return {
    project,
    section,
    number: item.number,
    key: item.key,
    askId: open?.id ?? null,
    title: item.title,
    url: null,
    ask: open?.ask ?? null,
    body: item.body,
    authorTrusted: item.createdBy.kind !== 'import',
    allowedCommands: (open?.commands ?? grammar).filter((command) => grammar.includes(command)),
    category: open?.category ?? null,
    recommendation: isTeamRecommendation(open?.recommended) ? open.recommended : null,
    // A console ask is the job's plain question, not a GitHub answer line: the card shows it as the question.
    context:
      open === null
        ? null
        : {
            summary: null,
            question: open.ask,
            why: null,
            ifApproved: null,
            ifRejected: null,
            costAndRisk: null,
            structured: false,
          },
  };
}

/**
 * "Waits for your decision" on the task screen (#409 §3): Approve / Reject by button only — #16's card and reason
 * sheet, posting an owner decision that names the open ask (#443) with its own idempotency key. Once recorded, the
 * receipt takes focus: "Approved · TC-345 · 14:05 · the team reads it on its next run".
 */
@Component({
  selector: 'tc-task-decision',
  imports: [AnswerQuestion, LocalTimePipe, QuestionCard, Receipt, TranslocoPipe],
  template: `
    @if (given(); as given) {
      <tc-receipt [tone]="isNegative() ? 'negative' : 'positive'" data-testid="task-decision-receipt">
        <span tc-receipt-verb>
          <span class="tc-task-decision__verb" tabindex="-1">{{
            'answer.receipt.status.' + given.response.command | transloco
          }}</span>
        </span>
        <span tc-receipt-detail dir="auto">{{ item().title }}</span>
        <span tc-receipt-meta>{{
          'item.decisionMeta' | transloco: { key: item().key, time: (givenAt() | localTime) }
        }}</span>
      </tc-receipt>
    } @else if (question(); as question) {
      <tc-question-card [item]="question" [showTaskLink]="false" data-testid="task-decision">
        <tc-answer-question
          tc-question-actions
          [item]="question"
          (answered)="onAnswered($event)"
          (refreshRequested)="refreshRequested.emit()"
        />
      </tc-question-card>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-task-decision' },
  // Nothing waits: no empty row in the screen's grid.
  styles: ':host { display: block; } :host(:empty) { display: none; }',
})
export class TaskDecision {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly slug = input.required<string>();
  readonly projectName = input.required<string>();
  readonly item = input.required<ItemDto>();
  readonly asks = input.required<readonly AskDto[]>();
  /** Recorded: the screen reads the task again (its status and History moved). */
  readonly decided = output<void>();
  readonly refreshRequested = output<void>();

  protected readonly given = signal<AnswerGiven | null>(null);
  protected readonly givenAt = signal<string>('');
  protected readonly question = computed(() =>
    decisionItemOf({ slug: this.slug(), name: this.projectName() }, this.item(), this.asks()),
  );
  protected readonly isNegative = computed(() => {
    const given = this.given();
    return given !== null && NEGATIVE.has(given.response.command);
  });

  protected onAnswered(given: AnswerGiven): void {
    this.given.set(given);
    this.givenAt.set(new Date().toISOString());
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('.tc-task-decision__verb')?.focus(),
      {
        injector: this.injector,
      },
    );
    this.decided.emit();
  }
}
