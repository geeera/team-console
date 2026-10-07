import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import {
  Button,
  Callout,
  Choice,
  ChoiceGroup,
  DIALOG_DATA,
  DialogRef,
  Icon,
  SheetFooter,
  StateBlock,
} from '@console/shared/ui';
import type {
  IssueRequestDto,
  OwnerRequest,
  OwnerRequestBody,
  OwnerRequestResponse,
  OwnerRequestStatusDto,
  SprintTarget,
} from '@shared/contracts';
import {
  initialChoiceOf,
  isSprintOffered,
  pickQueue,
  pickSprint,
  requestOf,
  whereOf,
  type QueueChoice,
  type RequestChoice,
} from './request-form';

/** How a send ended, worded by the caller. */
export type RequestSendAnswer =
  | { readonly ok: true; readonly response: OwnerRequestResponse }
  /** `refill`: the issue changed, read it again; `isFinal`: nothing more to send (a closed issue). */
  | { readonly ok: false; readonly message: string; readonly refill?: boolean; readonly isFinal?: boolean };

export interface RequestFormData {
  /** The issue read live, or `null` when GitHub did not answer. */
  readonly load: () => Promise<IssueRequestDto | null>;
  readonly send: (body: OwnerRequestBody) => Promise<RequestSendAnswer>;
  /** "перенести в Sprint 05" etc. for a request, in the active language. */
  readonly describe: (request: OwnerRequest, issue: IssueRequestDto) => string;
  /** "6 октября, 14:05" for the pending line. */
  readonly when: (iso: string) => string;
}

/** What the dialog closes with once the request is recorded. */
export interface RequestFormResult {
  readonly issue: IssueRequestDto;
  readonly request: OwnerRequest;
  readonly response: OwnerRequestResponse;
}

let nextFormId = 0;
const SPRINT_TARGETS: readonly SprintTarget[] = ['current', 'next', 'backlog'];
const QUEUE_CHOICES: readonly QueueChoice[] = ['up', 'keep', 'down'];

/**
 * "Ask the PM" (#219, design #29, wireframe #252): one request per send — another sprint or a place in the queue,
 * picking one clears the other. Shows where the issue is now and the previous request; a refusal keeps the form
 * open with the reason, and `issue-changed` re-reads the issue so the form shows the live sprint before a resend.
 */
@Component({
  selector: 'tc-request-form-dialog',
  imports: [Button, Callout, Choice, ChoiceGroup, Icon, SheetFooter, StateBlock, TranslocoPipe],
  template: `
    @if (issue(); as issue) {
      <form class="rq" novalidate [id]="id" (submit)="submit($event)">
        <p class="rq__now" data-testid="request-now">
          {{ 'commands.request.now' | transloco: { where: whereText(issue) } }}
        </p>
        @if (previous(); as previous) {
          <p class="rq__prev" data-testid="request-previous" [attr.data-state]="previous.state">
            {{ previous.text }}
          </p>
        }
        <fieldset
          tc-choice-group
          [legend]="'commands.request.sprint' | transloco"
          [attr.aria-describedby]="id + '-sprint-hint'"
        >
          @for (target of sprintTargets; track target) {
            <label tc-choice>
              <input
                type="radio"
                [name]="id + '-sprint'"
                [value]="target"
                [checked]="choice().sprint === target"
                [disabled]="!isSprintOffered(issue, target)"
                [attr.data-testid]="'request-sprint-' + target"
                (change)="setSprint(target)"
              />
              {{ sprintLabel(issue, target) }}
              @if (whereOf(issue) === target) {
                <span class="rq__here">{{ 'commands.request.here' | transloco }}</span>
              }
            </label>
          }
        </fieldset>
        <p class="rq__hint" [id]="id + '-sprint-hint'">{{ 'commands.request.sprintHint' | transloco }}</p>
        @if (issue.freezeNow && choice().sprint === 'current' && whereOf(issue) !== 'current') {
          <p tc-callout tone="warning" class="rq__note">
            <tc-icon name="alert" size="sm" /><span>{{ 'commands.request.freeze' | transloco }}</span>
          </p>
        }
        <fieldset
          tc-choice-group
          [legend]="'commands.request.prio' | transloco"
          [attr.aria-describedby]="id + '-queue-hint'"
        >
          @for (queue of queueChoices; track queue) {
            <label tc-choice>
              <input
                type="radio"
                [name]="id + '-queue'"
                [value]="queue"
                [checked]="choice().queue === queue"
                [attr.data-testid]="'request-queue-' + queue"
                (change)="setQueue(queue)"
              />
              {{ 'commands.request.' + queue | transloco }}
            </label>
          }
        </fieldset>
        <p class="rq__hint" [id]="id + '-queue-hint'">{{ 'commands.request.prioHint' | transloco }}</p>
        <p class="rq__hint">{{ 'commands.request.one' | transloco }}</p>
        <p class="rq__diff" aria-live="polite" data-testid="request-diff">
          @if (request(); as request) {
            {{ 'commands.request.diff' | transloco: { what: data.describe(request, issue) } }}
          } @else {
            {{ 'commands.request.diffNone' | transloco }}
          }
        </p>
        <p class="rq__hint" data-testid="request-reads">{{ 'commands.request.reads' | transloco }}</p>
        <p class="rq__hint">{{ 'commands.request.owner' | transloco }}</p>
        @if (failure(); as message) {
          <p tc-callout tone="danger" class="rq__note" role="alert" data-testid="request-error">
            <tc-icon name="alert" size="sm" /><span>{{ message }}</span>
          </p>
        }
      </form>
      <!-- The frame's footer sits outside the form, so the submit button names it (#274). -->
      <ng-template tcSheetFooter>
        @if (!isFinal()) {
          <button
            tc-button
            type="submit"
            variant="primary"
            data-testid="request-ok"
            [attr.form]="id"
            [loading]="running()"
            [off]="request() === null"
            [attr.aria-disabled]="running() || request() === null ? 'true' : null"
          >
            @if (running()) {
              {{ 'commands.dialog.sending' | transloco }}
            } @else if (request() === null) {
              {{ 'commands.request.okNone' | transloco }}
            } @else if (failure() !== null && !isRefilled()) {
              {{ 'commands.dialog.retry' | transloco }}
            } @else {
              {{ 'commands.request.ok' | transloco }}
            }
          </button>
        }
        <button tc-button type="button" [attr.aria-disabled]="running() ? 'true' : null" (click)="cancel()">
          {{ (isFinal() ? 'commands.request.closeBtn' : 'commands.dialog.cancel') | transloco }}
        </button>
      </ng-template>
    } @else if (loadFailed()) {
      <tc-state-block kind="error" compact [title]="'commands.request.loadError' | transloco">
        <button tc-button tc-state-action type="button" (click)="reload()">
          {{ 'commands.dialog.retry' | transloco }}
        </button>
      </tc-state-block>
    } @else {
      <tc-state-block kind="loading" compact [title]="'commands.request.loading' | transloco" />
    }
  `,
  styleUrl: './request-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestFormDialog {
  protected readonly data = inject<RequestFormData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<RequestFormResult>>(DialogRef);
  private readonly transloco = inject(TranslocoService);

  protected readonly id = `tc-request-${nextFormId++}`;
  protected readonly sprintTargets = SPRINT_TARGETS;
  protected readonly queueChoices = QUEUE_CHOICES;
  protected readonly whereOf = whereOf;
  protected readonly isSprintOffered = isSprintOffered;

  protected readonly issue = signal<IssueRequestDto | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly choice = signal<RequestChoice>({ sprint: null, queue: 'keep' });
  protected readonly running = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly isFinal = signal(false);
  /** The last failure re-read the issue: the button sends anew rather than retrying. */
  protected readonly isRefilled = signal(false);

  protected readonly request = computed(() => {
    const issue = this.issue();
    return issue === null ? null : requestOf(issue, this.choice());
  });

  protected readonly previous = computed(() => {
    const issue = this.issue();
    const previous: OwnerRequestStatusDto | null = issue?.request ?? null;
    if (issue === null || previous === null) {
      return null;
    }
    const what = this.data.describe(previous, issue);
    const text =
      previous.state === 'pending'
        ? this.t('commands.request.pending', { what, when: this.data.when(previous.requestedAt) })
        : this.t(`commands.request.${previous.state}`, { what });
    return { state: previous.state, text };
  });

  constructor() {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.loadFailed.set(false);
    const issue = await this.data.load();
    if (issue === null) {
      this.loadFailed.set(true);
      return;
    }
    this.apply(issue);
  }

  protected setSprint(target: SprintTarget): void {
    this.choice.set(pickSprint(target));
  }

  protected setQueue(queue: QueueChoice): void {
    const issue = this.issue();
    if (issue !== null) {
      this.choice.set(pickQueue(issue, queue));
    }
  }

  protected whereText(issue: IssueRequestDto): string {
    return issue.milestone ?? this.t('commands.request.backlogWhere');
  }

  protected sprintLabel(issue: IssueRequestDto, target: SprintTarget): string {
    if (target === 'current') {
      return this.t('commands.request.cur', { sprint: issue.current?.title ?? '—' });
    }
    if (target === 'next') {
      return issue.next === null
        ? this.t('commands.request.nextNone')
        : this.t('commands.request.next', { sprint: issue.next.title });
    }
    return this.t('commands.request.none');
  }

  protected cancel(): void {
    if (!this.running()) {
      this.ref.close();
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const issue = this.issue();
    const request = this.request();
    if (this.running() || issue === null || request === null || this.isFinal()) {
      return;
    }
    this.running.set(true);
    this.failure.set(null);
    this.ref.disableClose = true;
    let answer: RequestSendAnswer;
    try {
      answer = await this.data.send({ request, expectedMilestone: issue.milestone });
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    if (answer.ok) {
      this.ref.close({ issue, request, response: answer.response });
      return;
    }
    this.isFinal.set(answer.isFinal === true);
    this.isRefilled.set(answer.refill === true);
    if (answer.refill === true) {
      const live = await this.data.load();
      if (live !== null) {
        // The owner's choice stays where it still means something; the live sprint replaces the old one.
        const kept = this.choice();
        this.apply(live);
        if (kept.queue !== 'keep') {
          this.choice.set(pickQueue(live, kept.queue));
        } else if (kept.sprint !== null && isSprintOffered(live, kept.sprint)) {
          this.choice.set(pickSprint(kept.sprint));
        }
      }
    }
    this.failure.set(answer.message);
  }

  private apply(issue: IssueRequestDto): void {
    this.issue.set(issue);
    this.choice.set(initialChoiceOf(issue));
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
