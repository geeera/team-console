import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, DIALOG_DATA, DialogRef, Field, FieldControl, SheetFooter } from '@console/shared/ui';
import { ANSWER_TEXT_MAX_LENGTH } from '@shared/contracts';

let nextReasonId = 0;

export type ReasonCommand = 'reject' | 'no-go' | 'override';

export interface ReasonSheetData {
  readonly command: ReasonCommand;
}

/**
 * Asks for the reason `reject`, `no-go` and `override` need (owner grammar). For `override` it is also the
 * confirmation: the warning and an explicit "confirm" button. Closes with the trimmed reason, or nothing.
 */
@Component({
  selector: 'tc-answer-reason-sheet',
  imports: [Button, Field, FieldControl, SheetFooter, TranslocoPipe],
  template: `
    <form class="reason" [id]="formId" (submit)="submit($event)" novalidate>
      @if (data.command === 'override') {
        <p class="reason__warning" data-testid="override-warning">
          {{ 'answer.reason.overrideWarning' | transloco }}
        </p>
      }
      <tc-field
        [label]="'answer.reason.label' | transloco"
        [hint]="'answer.reason.hint' | transloco"
        [error]="showError() ? ('answer.reason.required' | transloco) : ''"
        required
      >
        <textarea
          tcInput
          class="reason__text"
          rows="4"
          [maxLength]="maxLength"
          [value]="reason()"
          (input)="onInput($event)"
        ></textarea>
      </tc-field>
    </form>
    <!-- The frame's footer sits outside the form, so the submit button names it (#274). -->
    <ng-template tcSheetFooter="primary">
      <button
        tc-button
        type="submit"
        [attr.form]="formId"
        [variant]="data.command === 'override' ? 'danger' : 'primary'"
      >
        {{ 'answer.reason.submit.' + data.command | transloco }}
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close()">{{ 'ui.confirm.cancel' | transloco }}</button>
    </ng-template>
  `,
  styleUrl: './reason-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReasonSheet {
  protected readonly data = inject<ReasonSheetData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<string>>(DialogRef);

  protected readonly formId = `tc-reason-${nextReasonId++}`;
  protected readonly maxLength = ANSWER_TEXT_MAX_LENGTH;
  protected readonly reason = signal('');
  protected readonly showError = signal(false);

  protected onInput(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) {
      this.reason.set(target.value);
      if (target.value.trim() !== '') {
        this.showError.set(false);
      }
    }
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const reason = this.reason().trim();
    if (reason === '') {
      this.showError.set(true);
      return;
    }
    this.ref.close(reason);
  }
}
