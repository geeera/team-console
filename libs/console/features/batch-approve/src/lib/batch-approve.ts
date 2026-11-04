import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { batchCandidatesOf, type QuestionItem } from '@console/entities/question';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Icon } from '@console/shared/ui';
import { BatchApproveOpener, type BatchApproved } from './batch-approve-opener';

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
  private readonly opener = inject(BatchApproveOpener);

  /** The items waiting in the list the button sits over (Needs you: every project's). */
  readonly items = input.required<readonly QuestionItem[]>();
  readonly closed = output<BatchApproved>();

  protected readonly count = computed(() => batchCandidatesOf(this.items()).candidates.length);
  protected readonly isOpen = this.opener.isOpen;

  async open(): Promise<void> {
    const result = await this.opener.open(this.items());
    if (result !== null && (result.approved.length > 0 || result.hasChanged)) {
      this.closed.emit(result);
    }
  }
}
