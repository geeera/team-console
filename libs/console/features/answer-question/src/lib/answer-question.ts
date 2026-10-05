import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RouterLink } from '@angular/router';
import { AnsweredItems, NeedsYouCounts } from '@console/entities/project';
import { QuestionItem } from '@console/entities/question';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, ButtonVariant, Sheet, StateBlock } from '@console/shared/ui';
import type { AnswerCommand, AnswerRequest, AnswerResponse } from '@shared/contracts';
import { NEEDS_REASON } from '@shared/owner-grammar';
import { AnswerClient, AnswerFailure, answerRequestOf } from './answer.client';
import { ReasonCommand, ReasonSheet, ReasonSheetData } from './reason-sheet';

/** The longest `Retry-After` of `answer-in-progress` the card waits out on its own before it asks the owner. */
export const IN_PROGRESS_MAX_WAIT_S = 5;

const VARIANTS: Readonly<Record<AnswerCommand, ButtonVariant>> = {
  approve: 'primary',
  go: 'primary',
  done: 'primary',
  reject: 'secondary',
  'no-go': 'secondary',
  override: 'quiet',
};

export interface AnswerGiven {
  readonly item: QuestionItem;
  readonly response: AnswerResponse;
}

function isReasonCommand(command: AnswerCommand): command is ReasonCommand {
  return NEEDS_REASON.has(command);
}

/**
 * The answers a card offers — exactly the item's `allowedCommands` — and the way to give one (#16): one tap for
 * approve and done; a confirmation for go; a written reason for reject, no-go and override (which is also
 * override's confirmation); and, on an item whose author is not trusted, a warning to confirm first, whatever the
 * answer. No optimistic update: the card stays until the endpoint has recorded the answer, and on failure it
 * stays with the reason. A repeat (double tap, Retry) sends the same request, so the endpoint replays instead of
 * posting twice.
 */
@Component({
  selector: 'tc-answer-question',
  imports: [Button, RouterLink, StateBlock, TranslocoPipe],
  template: `
    <div class="answer__actions" role="group" [attr.aria-label]="item().title">
      @for (command of item().allowedCommands; track command) {
        <button
          tc-button
          type="button"
          [variant]="variants[command]"
          [loading]="pending() === command"
          [attr.aria-disabled]="isBusy() ? 'true' : null"
          [attr.data-command]="command"
          (click)="answer(command)"
        >
          {{ 'answer.command.' + command | transloco }}
        </button>
      }
    </div>
    <p class="tc-sr-only" aria-live="polite">
      @if (pending() !== null) {
        {{ 'answer.busy' | transloco: { n: item().number } }}
      }
    </p>
    @if (failure(); as failure) {
      @if (failure.kind === 'not-connected') {
        <div class="answer__connect" data-testid="answer-connect" role="status">
          <p class="answer__connect-title">{{ 'answer.error.not-connected' | transloco }}</p>
          <p class="answer__connect-hint">{{ 'answer.error.not-connectedHint' | transloco }}</p>
          <a tc-button variant="primary" routerLink="/settings">{{
            'answer.error.connectAction' | transloco
          }}</a>
        </div>
      } @else {
        <tc-state-block
          kind="error"
          data-testid="answer-error"
          [attr.data-kind]="failure.kind"
          [title]="'answer.error.' + failure.kind | transloco"
          [description]="'answer.error.' + failure.kind + 'Hint' | transloco"
        >
          @switch (failure.recovery) {
            @case ('retry') {
              <button tc-button tc-state-action type="button" (click)="retry()">
                {{ 'answer.error.retry' | transloco }}
              </button>
            }
            @case ('refresh') {
              <button tc-button tc-state-action type="button" (click)="refreshRequested.emit()">
                {{ 'answer.error.refresh' | transloco }}
              </button>
            }
            @case ('settings') {
              <a tc-button tc-state-action routerLink="/settings">{{ 'shell.settings' | transloco }}</a>
            }
          }
        </tc-state-block>
      }
    }
  `,
  styleUrl: './answer-question.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-answer-question' },
})
export class AnswerQuestion {
  private readonly client = inject(AnswerClient);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  private readonly answeredItems = inject(AnsweredItems);
  private readonly counts = inject(NeedsYouCounts);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly item = input.required<QuestionItem>();
  /** The answer is recorded on GitHub (new or replayed). */
  readonly answered = output<AnswerGiven>();
  /** The item changed on GitHub (closed, no longer waiting): the list should be read again. */
  readonly refreshRequested = output<void>();

  protected readonly variants = VARIANTS;
  /** The command being written; set before any dialog opens, so a second tap is ignored. */
  protected readonly pending = signal<AnswerCommand | null>(null);
  private readonly asking = signal(false);
  protected readonly isBusy = computed(() => this.pending() !== null || this.asking());
  protected readonly failure = signal<AnswerFailure | null>(null);
  private lastRequest: AnswerRequest | null = null;

  async answer(command: AnswerCommand): Promise<void> {
    if (this.isBusy() || !this.item().allowedCommands.includes(command)) {
      return;
    }
    this.asking.set(true);
    let request: AnswerRequest | null;
    try {
      request = await this.prepare(command);
    } finally {
      this.asking.set(false);
    }
    if (request !== null) {
      await this.submit(request);
    }
  }

  /** Repeats the last request unchanged, so a comment that did get written is replayed, not posted again. */
  async retry(): Promise<void> {
    if (this.lastRequest !== null && !this.isBusy()) {
      await this.submit(this.lastRequest);
    }
  }

  /** The confirmations and the reason the answer needs; `null` when the owner backs out. */
  private async prepare(command: AnswerCommand): Promise<AnswerRequest | null> {
    const t = (key: string): string => this.transloco.translate(key);
    if (!this.item().authorTrusted) {
      const isSure = await this.sheet.confirm({
        title: t('answer.confirm.untrustedTitle'),
        message: t('answer.confirm.untrustedMessage'),
        confirmLabel: t('answer.confirm.untrustedOk'),
        tone: 'danger',
      });
      if (!isSure) {
        return null;
      }
    }
    const ownerSaid = t(`answer.command.${command}`);
    if (isReasonCommand(command)) {
      const ref = this.sheet.open<string, ReasonSheetData>(ReasonSheet, {
        title: t(`answer.reason.title.${command}`),
        data: { command },
        autoFocus: 'textarea',
      });
      const reason = await firstValueFrom(ref.closed);
      return typeof reason === 'string' && reason.trim() !== ''
        ? answerRequestOf(command, ownerSaid, reason)
        : null;
    }
    if (command === 'go') {
      const isSure = await this.sheet.confirm({
        title: t('answer.confirm.goTitle'),
        message: t('answer.confirm.goMessage'),
        confirmLabel: ownerSaid,
      });
      if (!isSure) {
        return null;
      }
    }
    return answerRequestOf(command, ownerSaid);
  }

  /** Retry lives in the error block, which goes away now: focus moves to the answer being repeated, not to the page. */
  private keepFocusOnRetry(command: AnswerCommand): void {
    const root = this.host.nativeElement;
    const focused = root.ownerDocument.activeElement;
    if (focused !== null && root.querySelector('[data-testid="answer-error"]')?.contains(focused)) {
      root.querySelector<HTMLElement>(`[data-command="${command}"]`)?.focus();
    }
  }

  private async submit(request: AnswerRequest): Promise<void> {
    const item = this.item();
    this.lastRequest = request;
    this.pending.set(request.command);
    this.keepFocusOnRetry(request.command);
    this.failure.set(null);
    let result = await this.client.submit(item.project.slug, item.number, request);
    if (!result.ok && result.failure.kind === 'in-progress') {
      // The same answer is being written by an earlier tap: wait for it, then the repeat is answered as a replay.
      const wait = Math.min(result.failure.retryAfter ?? 2, IN_PROGRESS_MAX_WAIT_S);
      await new Promise<void>((resolve) => setTimeout(resolve, wait * 1000));
      result = await this.client.submit(item.project.slug, item.number, request);
    }
    this.pending.set(null);
    if (!result.ok) {
      this.failure.set(result.failure);
      return;
    }
    this.answeredItems.record({
      slug: item.project.slug,
      number: item.number,
      command: result.response.command,
      url: result.response.url,
      answeredAt: new Date().toISOString(),
    });
    void this.counts.refresh();
    this.answered.emit({ item, response: result.response });
  }
}
