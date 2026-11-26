import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoPluralPipe } from '@console/shared/i18n';
import {
  Button,
  Callout,
  DIALOG_DATA,
  DialogRef,
  Field,
  FieldControl,
  Icon,
  SheetFooter,
} from '@console/shared/ui';
import { TEAM_CONFIG_REASON_MAX_LENGTH } from '@shared/contracts';
import { ChangesTable, type ChangeRow } from '../changes-table/changes-table';

/** What the save did, in the sheet's terms: close it, or stay with the failure and Try again. */
export type ReviewOutcome = 'close' | 'retry';

export interface ReviewSheetData {
  readonly rows: readonly ChangeRow[];
  /** Saves with the reason; `retry` keeps the sheet open with "Could not save…" and Try again. */
  readonly save: (reason: string) => Promise<ReviewOutcome>;
}

let nextReviewId = 0;

/**
 * Review and save (#688, UX spec §2.3): the changed settings as Setting · Was · Now in words, that they apply to the
 * next job, an optional reason (≤ 500) and Save. A network error or a 5xx keeps the sheet, the reason and the edits,
 * with the error as an alert and Save turned into Try again; every other outcome closes it and the page says what
 * happened (the field a 422 named, the conflict banner, the 403 banner).
 */
@Component({
  selector: 'tc-review-sheet',
  imports: [
    Button,
    Callout,
    ChangesTable,
    Field,
    FieldControl,
    Icon,
    SheetFooter,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  template: `
    <form class="review" novalidate [id]="id" (submit)="submit($event)">
      <p class="review__count">{{ 'teamConfig.bar.count' | translocoPlural: data.rows.length }}</p>
      <tc-changes-table [rows]="data.rows" />
      <p tc-callout class="review__applies">{{ 'teamConfig.review.applies' | transloco }}</p>
      <tc-field
        [label]="'teamConfig.review.reason' | transloco"
        [note]="'teamConfig.review.counter' | transloco: { n: reason().length, max: maxLength }"
      >
        <textarea
          tcInput
          rows="3"
          data-testid="review-reason"
          [maxLength]="maxLength"
          [value]="reason()"
          (input)="onInput($event)"
        ></textarea>
      </tc-field>
      @if (failed()) {
        <p tc-callout tone="danger" class="review__error" role="alert" data-testid="review-error">
          <tc-icon name="alert" size="sm" /><span>{{ 'teamConfig.review.failed' | transloco }}</span>
        </p>
      }
    </form>
    <ng-template tcSheetFooter="primary">
      <button
        tc-button
        type="submit"
        variant="primary"
        data-testid="review-save"
        [attr.form]="id"
        [loading]="running()"
        [attr.aria-disabled]="running() ? 'true' : null"
      >
        @if (running()) {
          {{ 'teamConfig.review.saving' | transloco }}
        } @else if (failed()) {
          {{ 'teamConfig.common.retry' | transloco }}
        } @else {
          {{ 'teamConfig.review.save' | transloco }}
        }
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" [attr.aria-disabled]="running() ? 'true' : null" (click)="cancel()">
        {{ 'teamConfig.common.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styles: `
    .review {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .review__count,
    .review__applies,
    .review__error {
      margin: 0;
    }

    .review__count {
      color: var(--text-2);
    }

    .review__error {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewSheet {
  protected readonly data = inject<ReviewSheetData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);

  protected readonly id = `tc-review-${nextReviewId++}`;
  protected readonly maxLength = TEAM_CONFIG_REASON_MAX_LENGTH;
  protected readonly reason = signal('');
  protected readonly running = signal(false);
  protected readonly failed = signal(false);

  protected onInput(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) {
      this.reason.set(target.value);
    }
  }

  protected cancel(): void {
    if (!this.running()) {
      this.ref.close(false);
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.running()) {
      return;
    }
    this.running.set(true);
    this.failed.set(false);
    this.ref.disableClose = true;
    let outcome: ReviewOutcome;
    try {
      outcome = await this.data.save(this.reason());
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    if (outcome === 'close') {
      this.ref.close(true);
    } else {
      this.failed.set(true);
    }
  }
}
