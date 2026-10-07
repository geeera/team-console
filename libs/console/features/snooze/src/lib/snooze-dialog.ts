import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import {
  Button,
  Callout,
  Choice,
  ChoiceGroup,
  DIALOG_DATA,
  DialogRef,
  Icon,
  SheetFooter,
} from '@console/shared/ui';
import type { SnoozeRequest } from '@shared/contracts';
import { SNOOZE_OPTIONS, snoozeUntilOf, type SnoozeOption } from './snooze-until';

export interface SnoozeDialogData {
  /** Stores the snooze; resolves with `null` when done, or with the alert to show (the dialog stays open). */
  readonly save: (request: SnoozeRequest) => Promise<string | null>;
  /** The clock the options count from; a seam for specs. */
  readonly now: () => Date;
}

let nextDialogId = 0;

/**
 * The snooze dialog of the design (#221): a plain dialog, no confirmation — how long, and whether urgent ones still
 * come (on by default). A failed save keeps it open with the reason and Try again; closes with `true` once stored.
 */
@Component({
  selector: 'tc-snooze-dialog',
  imports: [Button, Callout, Choice, ChoiceGroup, Icon, SheetFooter, TranslocoPipe],
  template: `
    <form class="snooze" novalidate [id]="id" (submit)="submit($event)">
      <p class="snooze__body" [id]="id + '-body'">{{ 'commands.snooze.dialog.body' | transloco }}</p>
      <fieldset tc-choice-group [legend]="'commands.snooze.dialog.when' | transloco">
        @for (option of options; track option) {
          <label tc-choice>
            <input
              type="radio"
              [name]="id + '-when'"
              [value]="option"
              [checked]="choice() === option"
              [attr.data-testid]="'snooze-' + option"
              (change)="choice.set(option)"
            />
            {{ 'commands.snooze.dialog.' + option | transloco }}
          </label>
        }
      </fieldset>
      <label tc-choice>
        <input
          type="checkbox"
          data-testid="snooze-urgent"
          [checked]="allowsUrgent()"
          [attr.aria-describedby]="id + '-urgent'"
          (change)="allowsUrgent.set($any($event.target).checked)"
        />
        {{ 'commands.snooze.dialog.urgent' | transloco }}
        <small tc-choice-hint [id]="id + '-urgent'">{{
          'commands.snooze.dialog.urgentHint' | transloco
        }}</small>
      </label>
      @if (failure(); as message) {
        <p tc-callout tone="danger" class="snooze__error" role="alert">
          <tc-icon name="alert" size="sm" /><span>{{ message }}</span>
        </p>
      }
    </form>
    <!-- The frame's footer sits outside the form, so the submit button names it (#274). -->
    <ng-template tcSheetFooter>
      <button
        tc-button
        type="submit"
        variant="primary"
        data-testid="snooze-ok"
        [attr.form]="id"
        [loading]="running()"
        [attr.aria-disabled]="running() ? 'true' : null"
      >
        @if (running()) {
          {{ 'commands.dialog.sending' | transloco }}
        } @else if (failure() !== null) {
          {{ 'commands.dialog.retry' | transloco }}
        } @else {
          {{ 'commands.snooze.dialog.ok' | transloco }}
        }
      </button>
      <button tc-button type="button" [attr.aria-disabled]="running() ? 'true' : null" (click)="cancel()">
        {{ 'commands.dialog.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styleUrl: './snooze-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SnoozeDialog {
  private readonly data = inject<SnoozeDialogData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);

  protected readonly id = `tc-snooze-${nextDialogId++}`;
  protected readonly options = SNOOZE_OPTIONS;
  protected readonly choice = signal<SnoozeOption>('morning');
  protected readonly allowsUrgent = signal(true);
  protected readonly running = signal(false);
  protected readonly failure = signal<string | null>(null);

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
    this.failure.set(null);
    this.ref.disableClose = true;
    let failure: string | null;
    try {
      // Counted at the press, not when the dialog opened: "an hour" is an hour from now.
      failure = await this.data.save({
        until: snoozeUntilOf(this.choice(), this.data.now()),
        allowsUrgent: this.allowsUrgent(),
      });
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    if (failure === null) {
      this.ref.close(true);
    } else {
      this.failure.set(failure);
    }
  }
}
