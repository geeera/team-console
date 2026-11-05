import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ItemsApi, looksLikeCommand, newIdempotencyKey, type FailedWrite } from '@console/entities/item';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Button } from '@console/shared/ui';
import { COMMENT_BODY_MAX_LENGTH, type CommentDto } from '@shared/contracts';

let nextId = 0;

/** A send as it went out: a retry repeats exactly this text with the same key. */
interface PendingComment {
  readonly body: string;
  readonly key: string;
}

/**
 * The comment box under a task's History (#409 §2.1): the team reads it on its next run, sent as is. A comment is
 * never a decision, whatever its text — a line starting with `/word` gets the note that says so. The unsent text is
 * kept on the device per task. Send is a `POST` with an idempotency key; a retry after a drop reuses it.
 */
@Component({
  selector: 'tc-item-comment',
  imports: [Button, TranslocoPipe],
  templateUrl: './item-comment.html',
  styleUrl: './item-comment.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-item-comment' },
})
export class ItemComment implements OnInit {
  private readonly api = inject(ItemsApi);
  private readonly drafts = inject(PersistedStateStore);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  readonly slug = input.required<string>();
  readonly number = input.required<number>();
  /** Picks the note's wording: "Use Approve or Reject above" only while a decision waits. */
  readonly isDecisionWaiting = input(false);
  readonly off = input<string | null>(null);
  readonly commented = output<CommentDto>();
  readonly failed = output<FailedWrite>();

  protected readonly id = `tc-item-comment-${nextId++}`;
  protected readonly text = signal('');
  protected readonly isSending = signal(false);
  protected readonly isCommandLike = computed(() => looksLikeCommand(this.text()));
  protected readonly isEmpty = computed(() => this.text().trim() === '');
  protected readonly describedBy = computed(() =>
    [
      `${this.id}-hint`,
      this.isCommandLike() ? `${this.id}-cmd` : null,
      this.off() !== null ? 'tc-task-off' : null,
    ]
      .filter((id) => id !== null)
      .join(' '),
  );
  private pending: PendingComment | null = null;

  ngOnInit(): void {
    this.text.set(this.drafts.taskDraftOf(this.slug(), this.number())?.comment ?? '');
  }

  protected setText(value: string): void {
    this.text.set(value);
    // A changed text is a new comment: never send it under the key of the one that failed.
    this.pending = null;
    this.drafts.setTaskDraft(this.slug(), this.number(), { comment: value });
  }

  async send(): Promise<void> {
    if (this.isSending() || this.off() !== null || this.isEmpty()) {
      if (this.isEmpty()) {
        this.field().nativeElement.focus();
      }
      return;
    }
    const body = this.text().slice(0, COMMENT_BODY_MAX_LENGTH);
    const pending =
      this.pending !== null && this.pending.body === body ? this.pending : { body, key: newIdempotencyKey() };
    await this.write(pending);
  }

  private async write(pending: PendingComment): Promise<void> {
    this.pending = pending;
    this.isSending.set(true);
    const result = await this.api.comment(this.slug(), this.number(), pending.body, pending.key);
    this.isSending.set(false);
    if (!result.ok) {
      this.failed.emit({ failure: result.failure, retry: () => this.write(pending) });
      return;
    }
    this.pending = null;
    this.text.set('');
    this.drafts.setTaskDraft(this.slug(), this.number(), { comment: null });
    this.commented.emit(result.value);
    this.field().nativeElement.focus();
    void this.announcer.announce(this.transloco.translate('item.commentSent'), 'polite');
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void this.send();
    }
  }
}
