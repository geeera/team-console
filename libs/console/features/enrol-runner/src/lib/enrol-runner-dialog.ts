import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import {
  RunnerProjectsPicker,
  RunnersApi,
  runnerFailureKeyOf,
  type RunnerProjectOption,
} from '@console/entities/runner';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import {
  Banner,
  Button,
  Callout,
  CopyCode,
  DIALOG_DATA,
  DialogRef,
  Field,
  FieldControl,
  Icon,
  SheetFooter,
} from '@console/shared/ui';
import { ENROLMENT_CODE_TTL_SECONDS, RUNNER_NAME_MAX_LENGTH, enrolCommandOf } from '@shared/contracts';

export interface EnrolRunnerData {
  readonly accountId: string;
  /** The account's active projects, for the runner's allow-list. */
  readonly projects: readonly RunnerProjectOption[];
}

/** What the dialog shows once the code exists: the command and when it stops working — never stored anywhere. */
interface IssuedCode {
  readonly command: string;
  readonly expiresAt: string;
  readonly name: string;
  readonly allowedProjects: readonly string[];
}

let nextFormId = 0;

/** One line, as the Worker stores it (`checkCreateEnrolmentCodeInput` trims). */
export function runnerNameOf(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * "New runner" (#464, ADR 0006 "Enrolment"): the owner names the runner and picks the projects it may serve; the
 * Worker answers a one-time code (10 minutes, single use) and the dialog shows the exact `enrol` command to paste on
 * the runner's host, once — with a Copy button, the expiry and a warning that it is not shown again. The code lives
 * in this dialog's memory only; closing it drops the code for good. Closes with `true` when a code was issued.
 */
@Component({
  selector: 'tc-enrol-runner-dialog',
  imports: [
    Banner,
    Button,
    Callout,
    CopyCode,
    Field,
    FieldControl,
    Icon,
    LocalTimePipe,
    RunnerProjectsPicker,
    SheetFooter,
    TranslocoPipe,
  ],
  template: `
    @if (issued(); as code) {
      <div class="enrol" data-testid="enrol-code">
        <section tc-callout tone="warning" [attr.aria-labelledby]="formId + '-once'">
          <h3 #codeHeading tc-callout-title tabindex="-1" [id]="formId + '-once'">
            {{ 'runners.enrol.onceTitle' | transloco }}
          </h3>
          <p>{{ 'runners.enrol.onceBody' | transloco }}</p>
        </section>
        <p class="enrol__lead">{{ 'runners.enrol.paste' | transloco: { name: code.name } }}</p>
        <tc-copy-code
          data-testid="enrol-command"
          [code]="code.command"
          [ariaLabel]="'runners.enrol.copyAria' | transloco"
          [copyLabel]="'runners.enrol.copy' | transloco"
          [copiedLabel]="'runners.enrol.copied' | transloco"
          [failedNote]="'runners.enrol.copyFailed' | transloco"
        />
        <p class="enrol__meta" data-testid="enrol-expiry">
          {{ 'runners.enrol.expires' | transloco: { time: code.expiresAt | localTime, minutes: ttlMinutes } }}
        </p>
        <p class="enrol__meta">
          @if (code.allowedProjects.length > 0) {
            {{ 'runners.enrol.projects' | transloco: { projects: code.allowedProjects.join(', ') } }}
          } @else {
            {{ 'runners.enrol.noProjects' | transloco }}
          }
        </p>
      </div>
      <ng-template tcSheetFooter="primary">
        <button tc-button type="button" variant="primary" data-testid="enrol-done" (click)="ref.close(true)">
          {{ 'runners.enrol.done' | transloco }}
        </button>
      </ng-template>
    } @else {
      <form class="enrol" [id]="formId" (submit)="submit($event)" novalidate>
        <p class="enrol__lead">{{ 'runners.enrol.lead' | transloco }}</p>
        <tc-field
          [label]="'runners.enrol.name' | transloco"
          [hint]="'runners.enrol.nameHint' | transloco"
          [error]="nameError() ?? ''"
          required
        >
          <input
            tcInput
            type="text"
            autocomplete="off"
            data-testid="enrol-name"
            [maxLength]="nameMaxLength"
            [readOnly]="running()"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
          />
        </tc-field>
        <tc-runner-projects-picker
          [legend]="'runners.projects.legend' | transloco"
          [projects]="data.projects"
          [disabled]="running()"
          [(selected)]="projects"
        />
        @if (failure(); as message) {
          <div tc-banner tone="danger" role="alert" data-testid="enrol-error">
            <tc-icon tc-banner-icon name="alert" size="sm" />
            <p tc-banner-text>{{ message }}</p>
          </div>
        }
      </form>
      <ng-template tcSheetFooter="primary">
        <button
          tc-button
          type="submit"
          variant="primary"
          data-testid="enrol-submit"
          [attr.form]="formId"
          [loading]="running()"
          [attr.aria-disabled]="running() ? 'true' : null"
        >
          @if (running()) {
            {{ 'runners.enrol.busy' | transloco }}
          } @else if (failure() !== null) {
            {{ 'ui.error.retry' | transloco }}
          } @else {
            {{ 'runners.enrol.submit' | transloco }}
          }
        </button>
      </ng-template>
      <ng-template tcSheetFooter="secondary">
        <button tc-button type="button" [attr.aria-disabled]="running() ? 'true' : null" (click)="cancel()">
          {{ 'ui.confirm.cancel' | transloco }}
        </button>
      </ng-template>
    }
  `,
  styles: `
    .enrol {
      display: grid;
      gap: var(--space-4);
    }

    .enrol__lead,
    .enrol__meta {
      margin: 0;
      color: var(--text-2);
    }

    .enrol__meta {
      font-size: var(--fs-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnrolRunnerDialog {
  protected readonly data = inject<EnrolRunnerData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly api = inject(RunnersApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly codeHeading = viewChild<ElementRef<HTMLElement>>('codeHeading');

  protected readonly formId = `tc-enrol-runner-${nextFormId++}`;
  protected readonly nameMaxLength = RUNNER_NAME_MAX_LENGTH;
  protected readonly ttlMinutes = Math.round(ENROLMENT_CODE_TTL_SECONDS / 60);
  protected readonly name = signal('');
  protected readonly projects = signal<readonly string[]>([]);
  protected readonly running = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly issued = signal<IssuedCode | null>(null);
  private readonly touched = signal(false);

  protected readonly nameError = computed((): string | null =>
    this.touched() && runnerNameOf(this.name()) === '' ? this.t('runners.enrol.nameEmpty') : null,
  );

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
    this.touched.set(true);
    const name = runnerNameOf(this.name());
    if (name === '') {
      this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    this.running.set(true);
    this.failure.set(null);
    // aria-disabled, not disabled: the focused button keeps focus while the write runs.
    this.ref.disableClose = true;
    const result = await this.api.createEnrolmentCode(this.data.accountId, {
      name,
      allowedProjects: this.projects(),
    });
    this.running.set(false);
    this.ref.disableClose = false;
    if (!result.ok) {
      this.failure.set(this.t(runnerFailureKeyOf(result.failure)));
      return;
    }
    const command = enrolCommandOf(result.value);
    if (command === null) {
      // A code we would not offer for a terminal: nothing to paste, so nothing is shown.
      this.failure.set(this.t('runners.err.error'));
      return;
    }
    this.issued.set({
      command,
      expiresAt: result.value.expiresAt,
      name: result.value.name,
      allowedProjects: result.value.allowedProjects,
    });
    void this.announcer.announce(this.t('runners.enrol.issued'), 'polite');
    afterNextRender(() => this.codeHeading()?.nativeElement.focus(), { injector: this.injector });
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
