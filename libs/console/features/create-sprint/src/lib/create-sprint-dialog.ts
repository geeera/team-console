import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ItemsApi, type TrackerFailure } from '@console/entities/item';
import {
  localCalendarDayOf,
  localCalendarRangeOf,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import {
  Banner,
  Button,
  DatePicker,
  DIALOG_DATA,
  DialogRef,
  Field,
  FieldControl,
  Icon,
  SheetFooter,
  type DatePickerProblem,
} from '@console/shared/ui';
import { SPRINT_TITLE_MAX_LENGTH, freezeOf, isCalendarDate, type TrackerSprintDto } from '@shared/contracts';

/** What the dialog is opened with: everything it checks is read once, before it opens. */
export interface CreateSprintData {
  readonly slug: string;
  /** The project's sprints as read when the dialog opened (the latest one, the names already taken). */
  readonly sprints: readonly TrackerSprintDto[];
  /** The name the server would give it without one (`Sprint NN`). */
  readonly suggestedName: string;
  readonly today: string;
  /** The demo date the field opens with. */
  readonly dueOn: string;
  /** project.yml's `sprint.freeze_days` (#457), or the plugin's default when it could not be read. */
  readonly freezeDays: number;
  /** One key for the dialog's life: Try again after a drop never creates two sprints. */
  readonly idempotencyKey: string;
}

let nextFormId = 0;

/** One line of plain text, as the server stores it (`checkCreateSprintInput`): whitespace runs are one space. */
export function sprintNameOf(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** The body `createSprint` sends: what the server records, so a changed body after a failed send needs a new key. */
export interface CreateSprintBody {
  readonly dueOn: string;
  readonly title: string | null;
}

function isSameSprintBody(a: CreateSprintBody, b: CreateSprintBody): boolean {
  return a.dueOn === b.dueOn && a.title === b.title;
}

/**
 * "New sprint" (#409 §2.3, #457): the name — prefilled with the next `Sprint NN`, editable — and the demo date,
 * checked as the owner types (an empty or taken name; a past date or one not after the latest demo), with the hint
 * saying when it starts and when its freeze is. A name left as suggested is not sent, so the server numbers and names
 * it even if another sprint was created meanwhile. Closes with the created sprint.
 */
@Component({
  selector: 'tc-create-sprint-dialog',
  imports: [Banner, Button, DatePicker, Field, FieldControl, FormsModule, Icon, SheetFooter, TranslocoPipe],
  template: `
    <form class="sprint-new" [id]="formId" (submit)="submit($event)" novalidate>
      <p class="sprint-new__after">{{ 'sprintNew.after' | transloco }}</p>
      <tc-field [label]="'sprintNew.name' | transloco" [error]="nameError() ?? ''" required>
        <input
          tcInput
          type="text"
          autocomplete="off"
          enterkeyhint="next"
          data-testid="sprint-name"
          [maxLength]="nameMaxLength"
          [readOnly]="running()"
          [value]="name()"
          (input)="name.set($any($event.target).value)"
        />
      </tc-field>
      <tc-field
        [label]="'sprintNew.date' | transloco"
        [error]="dateCheck().error ?? ''"
        [hint]="dateCheck().hint ?? ''"
        required
      >
        <tc-date-picker
          data-testid="sprint-date"
          [label]="'sprintNew.date' | transloco"
          [min]="data.today"
          [today]="data.today"
          [readonly]="running()"
          [ngModel]="dueOn()"
          [ngModelOptions]="{ standalone: true }"
          (ngModelChange)="dueOn.set($event ?? '')"
          (problemChange)="pickerProblem.set($event)"
        />
      </tc-field>
      @if (failure(); as message) {
        <div tc-banner tone="danger" role="alert" data-testid="sprint-new-error">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ message }}</p>
        </div>
      }
    </form>
    <!-- The frame's footer sits outside the form, so the submit button names it (#274). -->
    <ng-template tcSheetFooter="primary">
      <button
        tc-button
        type="submit"
        variant="primary"
        data-testid="sprint-new-ok"
        [attr.form]="formId"
        [loading]="running()"
        [attr.aria-disabled]="running() ? 'true' : null"
      >
        @if (running()) {
          {{ 'sprintNew.busy' | transloco }}
        } @else if (failure() !== null) {
          {{ 'ui.error.retry' | transloco }}
        } @else {
          {{ 'sprintNew.ok' | transloco: { sprint: shownName() } }}
        }
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" [attr.aria-disabled]="running() ? 'true' : null" (click)="cancel()">
        {{ 'ui.confirm.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styles: `
    .sprint-new {
      display: grid;
      gap: var(--space-4);
    }

    .sprint-new__after {
      margin: 0;
      color: var(--text-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateSprintDialog {
  protected readonly data = inject<CreateSprintData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<TrackerSprintDto>>(DialogRef);
  private readonly api = inject(ItemsApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly formId = `tc-sprint-new-${nextFormId++}`;
  protected readonly nameMaxLength = SPRINT_TITLE_MAX_LENGTH;
  protected readonly name = signal(this.data.suggestedName);
  protected readonly dueOn = signal(this.data.dueOn);
  protected readonly pickerProblem = signal<DatePickerProblem | null>(null);
  protected readonly running = signal(false);
  protected readonly failure = signal<string | null>(null);
  /** A refusal of the name by the server (422 `field: title`): shown until the name changes. */
  private readonly refusedName = signal<string | null>(null);
  /** The key the next send uses; starts as the dialog's own, rotates once the body changes after a failed send
   * (#470 item 2, as `AnswerQuestion` does) so a retry replays but an edited body is a fresh request. */
  private idempotencyKey = this.data.idempotencyKey;
  private lastSent: CreateSprintBody | null = null;

  private readonly latest = [...this.data.sprints].sort((a, b) => b.number - a.number)[0] ?? null;
  private readonly takenNames = new Set(this.data.sprints.map((sprint) => sprint.title.toLocaleLowerCase()));

  protected readonly shownName = computed(() => sprintNameOf(this.name()) || this.data.suggestedName);

  protected readonly nameError = computed((): string | null => {
    const name = sprintNameOf(this.name());
    if (name === '') {
      return this.t('sprintNew.errNameEmpty');
    }
    if (this.takenNames.has(name.toLocaleLowerCase())) {
      return this.t('sprintNew.errName');
    }
    return this.refusedName() === name ? this.t('sprintNew.errNameInvalid') : null;
  });

  protected readonly dateCheck = computed((): { readonly error?: string; readonly hint?: string } => {
    const problem = this.pickerProblem();
    const value = this.dueOn();
    if (problem?.kind === 'invalid') {
      return { error: problem.message };
    }
    if (!isCalendarDate(value)) {
      return { error: this.t('sprintNew.errEmpty') };
    }
    if (value < this.data.today) {
      return { error: this.t('sprintNew.errPast') };
    }
    const after = this.latest?.dueOn ?? null;
    if (this.latest !== null && after !== null && value <= after) {
      return {
        error: this.t('sprintNew.errBefore', {
          sprint: this.shownName(),
          prev: this.latest.title,
          date: this.day(after),
        }),
      };
    }
    if (problem !== null) {
      return { error: problem.message };
    }
    const freeze = freezeOf(value, this.data.freezeDays);
    const range = this.range(freeze.from, freeze.to);
    return {
      hint:
        this.latest !== null && after !== null
          ? this.t('sprintNew.hint', { prev: this.latest.title, date: this.day(after), freeze: range })
          : this.t('sprintNew.hintFirst', { freeze: range }),
    };
  });

  protected cancel(): void {
    if (!this.running()) {
      this.ref.close();
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.running()) {
      return;
    }
    if (this.nameError() !== null || this.dateCheck().error !== undefined) {
      this.focusFirstInvalid();
      return;
    }
    const name = sprintNameOf(this.name());
    const body: CreateSprintBody = { dueOn: this.dueOn(), title: name === this.data.suggestedName ? null : name };
    if (this.lastSent !== null && !isSameSprintBody(this.lastSent, body)) {
      this.idempotencyKey = crypto.randomUUID();
    }
    this.lastSent = body;
    this.running.set(true);
    this.failure.set(null);
    // aria-disabled, not disabled: the focused button keeps focus while the write runs.
    this.ref.disableClose = true;
    const result = await this.api.createSprint(this.data.slug, body, this.idempotencyKey);
    this.running.set(false);
    this.ref.disableClose = false;
    if (!result.ok) {
      if (result.failure.kind === 'invalid' && result.failure.field === 'title') {
        this.refusedName.set(name);
        this.focusFirstInvalid();
        return;
      }
      this.failure.set(this.failureText(result.failure));
      return;
    }
    const sprint = result.value;
    const done = this.t('sprintNew.done', { sprint: sprint.title, date: this.day(sprint.dueOn ?? '') });
    void this.announcer.announce(done, 'polite');
    this.ref.close(sprint);
  }

  private focusFirstInvalid(): void {
    this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }

  private failureText(failure: TrackerFailure): string {
    switch (failure.kind) {
      case 'forbidden':
        return `${this.t('item.err.forbidden.title')}. ${this.t('item.err.forbidden.message')}`;
      case 'timeout':
        return this.t('item.err.timeout.message');
      case 'invalid':
        return this.t('sprintNew.errInvalid');
      default:
        return this.t('item.err.network.message');
    }
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }

  private day(day: string): string {
    return localCalendarDayOf(day, this.transloco.getActiveLang());
  }

  private range(from: string, to: string): string {
    return localCalendarRangeOf(from, to, this.transloco.getActiveLang());
  }
}
