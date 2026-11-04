import { inject, Injectable, signal } from '@angular/core';
import { batchCandidatesOf, type QuestionItem } from '@console/entities/question';
import { TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { firstValueFrom } from 'rxjs';
import { BatchApproveDialog, BatchSession, type BatchApproveData } from './batch-approve-dialog';

/** What a closed batch dialog recorded: the approved items, and whether the list should be read again. */
export interface BatchApproved {
  readonly approved: readonly QuestionItem[];
  readonly hasChanged: boolean;
}

/**
 * Opens "Approve team recommendations" (#220) over the waiting items an entry point holds — the Needs you button and
 * the Commands panel row (#246) alike, so both offer the same batch and send the same requests. One dialog at a
 * time: a second press while it is open does nothing. The CDK dialog returns focus to the pressed control.
 */
@Injectable({ providedIn: 'root' })
export class BatchApproveOpener {
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);

  private readonly openNow = signal(false);
  readonly isOpen = this.openNow.asReadonly();

  /** `null` when nothing opened (nothing safe to batch, or a dialog is open already). */
  async open(items: readonly QuestionItem[]): Promise<BatchApproved | null> {
    const { candidates, leftOut } = batchCandidatesOf(items);
    if (candidates.length === 0 || this.openNow()) {
      return null;
    }
    const isAll = new Set(candidates.map((item) => item.project.slug)).size > 1;
    const session = new BatchSession();
    this.openNow.set(true);
    try {
      const ref = this.sheet.open<void, BatchApproveData>(BatchApproveDialog, {
        title: this.transloco.translate(isAll ? 'commands.batch.titleAll' : 'commands.batch.title'),
        role: 'alertdialog',
        data: { candidates, leftOut, session },
        autoFocus: '[data-testid="batch-ok"]',
      });
      await firstValueFrom(ref.closed);
    } finally {
      this.openNow.set(false);
    }
    return { approved: session.approved(), hasChanged: session.changed().length > 0 };
  }
}
