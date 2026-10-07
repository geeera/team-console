import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { batchCandidatesOf, type QuestionItem } from '@console/entities/question';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, Sheet } from '@console/shared/ui';
import { firstValueFrom } from 'rxjs';
import { BatchApproveDialog, BatchSession, type BatchApproveData } from './batch-approve-dialog';

/** What a closed batch dialog recorded: the approved items, and whether the list should be read again. */
export interface BatchApproved {
  readonly approved: readonly QuestionItem[];
  readonly hasChanged: boolean;
}

/**
 * "Approve team recommendations (N)" (#220): opens the batch dialog over the waiting items it is given. With
 * nothing safe to batch it stays visible but off, and says so. Hidden while nothing waits at all.
 */
@Component({
  selector: 'tc-batch-approve',
  imports: [Button, Icon, TranslocoPipe],
  template: `
    @if (items().length > 0) {
      <button
        tc-button
        type="button"
        size="sm"
        class="batch-approve"
        data-testid="batch-approve"
        [variant]="count() > 0 ? 'primary' : 'secondary'"
        [off]="count() === 0"
        [attr.aria-disabled]="count() === 0 || isOpen() ? 'true' : null"
        aria-haspopup="dialog"
        (click)="open()"
      >
        <tc-icon name="check" size="sm" />
        @if (count() > 0) {
          {{ 'commands.batch.approve' | transloco: { n: count() } }}
        } @else {
          {{ 'commands.batch.approveNone' | transloco }}
        }
      </button>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    @media (max-width: 519.98px) {
      .batch-approve {
        width: 100%;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchApprove {
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);

  /** The items waiting in the list the button sits over (Needs you: every project's). */
  readonly items = input.required<readonly QuestionItem[]>();
  readonly closed = output<BatchApproved>();

  private readonly batch = computed(() => batchCandidatesOf(this.items()));
  protected readonly count = computed(() => this.batch().candidates.length);
  protected readonly isOpen = signal(false);

  async open(): Promise<void> {
    const { candidates, leftOut } = this.batch();
    if (candidates.length === 0 || this.isOpen()) {
      return;
    }
    const isAll = new Set(candidates.map((item) => item.project.slug)).size > 1;
    const session = new BatchSession();
    this.isOpen.set(true);
    try {
      const ref = this.sheet.open<void, BatchApproveData>(BatchApproveDialog, {
        title: this.transloco.translate(isAll ? 'commands.batch.titleAll' : 'commands.batch.title'),
        role: 'alertdialog',
        data: { candidates, leftOut, session },
        autoFocus: '[data-testid="batch-ok"]',
      });
      await firstValueFrom(ref.closed);
    } finally {
      this.isOpen.set(false);
    }
    const approved = session.approved();
    const hasChanged = session.changed().length > 0;
    if (approved.length > 0 || hasChanged) {
      this.closed.emit({ approved, hasChanged });
    }
  }
}
