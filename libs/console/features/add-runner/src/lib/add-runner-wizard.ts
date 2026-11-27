import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import {
  EnrolmentWatch,
  POLL_FAILURES_SHOWN,
  RunnerCheckWatch,
  RunnersApi,
  runnerFailureKeyOf,
  runnerNameOf,
  type EnrolmentWatchStop,
  type RunnerFailure,
  type RunnerProjectOption,
} from '@console/entities/runner';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import {
  Banner,
  Button,
  DIALOG_DATA,
  DialogRef,
  Icon,
  isPhoneSignal,
  Sheet,
  SheetCloseGuard,
  SheetFooter,
  Toaster,
} from '@console/shared/ui';
import {
  DEFAULT_RUNNER_PROJECT_SCOPE,
  type EnrolmentIntentDto,
  type LinuxInstallCommandsDto,
  type MacReleasePlatform,
  type RunnerInstallCommandsDto,
  type RunnerProjectScope,
} from '@shared/contracts';
import {
  APPROVE_ARM_MS,
  COUNTDOWN_TICK_MS,
  fingerprintSpokenOf,
  SLOW_AFTER_MS,
  type AddRunnerOutcome,
  type RunnerPlatform,
  type WizardEnd,
  type WizardStep,
} from './add-runner.model';
import { RunnerCheckFlow } from './runner-check-flow';
import { AddRunnerCommandStep } from './steps/command-step';
import { AddRunnerConfirmStep } from './steps/confirm-step';
import { AddRunnerEndedStep } from './steps/ended-step';
import { AddRunnerOnlineStep } from './steps/online-step';
import { AddRunnerParamsStep } from './steps/params-step';
import { AddRunnerStepIndicator } from './steps/step-indicator';

export interface AddRunnerData {
  readonly accountId: string;
  /** The account's active projects, for the scope. */
  readonly projects: readonly RunnerProjectOption[];
  /** The release the environment names, for the runbook path. */
  readonly releaseVersion: string | null;
}

/** What the API answered at create: kept in this sheet's memory only, never in a URL or storage. */
interface CreatedIntent {
  readonly intentId: string;
  readonly expiresAt: string;
  readonly setupCommand: string;
  readonly install: RunnerInstallCommandsDto | null;
  readonly linux: LinuxInstallCommandsDto | null;
}

type Phase = 'params' | 'command' | 'confirm' | 'approved' | 'ended';
type Busy = 'creating' | 'approving' | 'rejecting' | 'withdrawing' | 'rereading' | 'rechecking';

const STEP_OF: Readonly<Record<Exclude<Phase, 'ended'>, WizardStep>> = {
  params: 'params',
  command: 'command',
  confirm: 'confirm',
  approved: 'online',
};

let nextWizardId = 0;

/**
 * Settings › Runners › «Подключить раннер» (#634 PR 4, UX spec): name, scope and platform; the API's one command for
 * the Mac's Terminal; the owner compares the bound machine's fingerprint and approves it; the runner comes online.
 * Linux gets the API's two commands for a `container` request (#634 PR 7), or, when the environment names no runner
 * image, closes with `code` and the page opens the one-time-code dialog (decision 1). The intent id lives in this
 * sheet's memory and in the path of the owner's own calls only (R-INT-2); closing while it is live withdraws it.
 */
@Component({
  selector: 'tc-add-runner-wizard',
  imports: [
    AddRunnerCommandStep,
    AddRunnerConfirmStep,
    AddRunnerEndedStep,
    AddRunnerOnlineStep,
    AddRunnerParamsStep,
    AddRunnerStepIndicator,
    Banner,
    Button,
    Icon,
    NgTemplateOutlet,
    SheetFooter,
    TranslocoPipe,
  ],
  providers: [EnrolmentWatch, RunnerCheckWatch, RunnerCheckFlow],
  template: `
    <div class="wizard" [attr.aria-busy]="busy() === 'rereading' ? 'true' : null">
      <tc-add-runner-step-indicator [step]="step()" [compact]="isPhone()" />
      @if (!online()) {
        <div tc-banner tone="warning" role="status" data-testid="wizard-offline" [id]="wizardId + '-offline'">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ 'runners.wizard.offline' | transloco }}</p>
        </div>
      } @else if (watch.rateLimitedFor() ?? checks.rateLimitedFor(); as seconds) {
        <div tc-banner tone="warning" role="status" data-testid="wizard-poll-limited">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ 'runners.wizard.pollRateLimited' | transloco: { seconds } }}</p>
        </div>
      } @else if (pollFailing()) {
        <div tc-banner tone="warning" role="status" data-testid="wizard-poll-failing">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ 'runners.wizard.pollFailing' | transloco }}</p>
        </div>
      }
      @switch (phase()) {
        @case ('params') {
          <tc-add-runner-params-step
            [formId]="wizardId"
            [projects]="data.projects"
            [ownerCount]="ownerCount()"
            [busy]="busy() === 'creating'"
            [nameError]="nameError()"
            [(name)]="name"
            [(scope)]="scope"
            [(selected)]="selected"
            [(platform)]="platform"
            (submitted)="submit($event)"
          >
            <ng-container *ngTemplateOutlet="failureBanner" />
          </tc-add-runner-params-step>
        }
        @case ('command') {
          @if (created(); as intent) {
            <tc-add-runner-command-step
              [name]="runnerName()"
              [setupCommand]="intent.setupCommand"
              [installCommands]="intent.install"
              [linuxInstall]="intent.linux"
              [releaseVersion]="data.releaseVersion"
              [expiresAt]="intent.expiresAt"
              [now]="now()"
              [isPhone]="isPhone()"
              [(arch)]="arch"
            />
          }
          <ng-container *ngTemplateOutlet="failureBanner" />
        }
        @case ('confirm') {
          @if (shown(); as intent) {
            <tc-add-runner-confirm-step [intent]="intent" [now]="now()" [lang]="lang" />
          }
          <ng-container *ngTemplateOutlet="failureBanner" />
        }
        @case ('approved') {
          <tc-add-runner-online-step
            [name]="runnerName()"
            [runner]="watch.runner()"
            [slow]="slow()"
            [minimumVersion]="watch.minimumVersion()"
            [projectScope]="scope()"
            [allowedProjects]="scope() === 'all' ? [] : selected()"
            [gaveUp]="watch.gaveUp()"
            [platform]="platform()"
            [rechecking]="busy() === 'rechecking'"
            (recheck)="recheck()"
            [check]="checks.view()"
            [canStartCheck]="!checks.forbidden()"
            [browserOnline]="online()"
            [checkRetryReady]="checks.retryReady()"
            [checkQueuedSlow]="checks.queuedSlow()"
            (checkStart)="startCheck()"
          />
          <ng-container *ngTemplateOutlet="failureBanner" />
        }
        @case ('ended') {
          <tc-add-runner-ended-step [reason]="ended()" />
          <ng-container *ngTemplateOutlet="failureBanner" />
        }
      }
    </div>

    <ng-template #failureBanner>
      @if (failure() ?? checkFailure(); as message) {
        <div tc-banner tone="danger" role="alert" data-testid="wizard-error">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>
            {{ message }}
            @if (offerCode()) {
              <button
                tc-button
                size="sm"
                type="button"
                variant="quiet"
                data-testid="wizard-to-code"
                (click)="toCode()"
              >
                {{ 'runners.wizard.err.toCode' | transloco }}
              </button>
            }
          </p>
        </div>
      }
    </ng-template>

    @switch (phase()) {
      @case ('params') {
        <ng-template tcSheetFooter="primary">
          <button
            tc-button
            type="submit"
            variant="primary"
            data-testid="wizard-submit"
            [attr.form]="wizardId"
            [loading]="busy() === 'creating'"
            [attr.aria-disabled]="busy() !== null ? 'true' : null"
          >
            @if (busy() === 'creating') {
              {{ 'runners.wizard.busy' | transloco }}
            } @else if (failure() !== null) {
              {{ 'ui.error.retry' | transloco }}
            } @else {
              {{ 'runners.wizard.submit' | transloco }}
            }
          </button>
        </ng-template>
        <ng-template tcSheetFooter="secondary">
          <button
            tc-button
            type="button"
            [attr.aria-disabled]="busy() !== null ? 'true' : null"
            (click)="requestClose()"
          >
            {{ 'ui.confirm.cancel' | transloco }}
          </button>
        </ng-template>
      }
      @case ('command') {
        <ng-template tcSheetFooter="secondary">
          <button
            tc-button
            type="button"
            data-testid="wizard-withdraw"
            [loading]="busy() === 'withdrawing'"
            [attr.aria-disabled]="busy() !== null ? 'true' : null"
            (click)="withdraw()"
          >
            {{ 'runners.wizard.withdraw' | transloco }}
          </button>
        </ng-template>
      }
      @case ('confirm') {
        <!-- Free-form: «Отклонить» first in the DOM on every screen; the phone shows «Подтвердить» on top (spec §7). -->
        <ng-template tcSheetFooter>
          <div class="wizard__decide">
            <button
              tc-button
              type="button"
              variant="danger"
              data-testid="wizard-reject"
              [loading]="busy() === 'rejecting'"
              [attr.aria-disabled]="busy() !== null || !online() ? 'true' : null"
              [attr.aria-describedby]="online() ? null : wizardId + '-offline'"
              (click)="reject()"
            >
              @if (busy() === 'rejecting') {
                {{ 'runners.wizard.confirm.rejecting' | transloco }}
              } @else {
                {{ 'runners.wizard.confirm.reject' | transloco }}
              }
            </button>
            <button
              tc-button
              type="button"
              variant="primary"
              data-testid="wizard-approve"
              [loading]="busy() === 'approving'"
              [attr.aria-disabled]="
                busy() !== null || !online() || suspended() || !approveArmed() ? 'true' : null
              "
              [attr.aria-describedby]="online() ? null : wizardId + '-offline'"
              (click)="approve()"
            >
              @if (busy() === 'approving') {
                {{ 'runners.wizard.confirm.approving' | transloco }}
              } @else {
                {{ 'runners.wizard.confirm.approve' | transloco }}
              }
            </button>
          </div>
        </ng-template>
      }
      @case ('approved') {
        <ng-template tcSheetFooter="primary">
          <button
            tc-button
            type="button"
            variant="primary"
            data-testid="wizard-done"
            (click)="requestClose()"
          >
            @if (watch.runner()?.online) {
              {{ 'runners.wizard.done' | transloco }}
            } @else {
              {{ 'runners.wizard.close' | transloco }}
            }
          </button>
        </ng-template>
        @if (watch.runner()?.online && scope() === 'selected' && selected().length === 0) {
          <ng-template tcSheetFooter="secondary">
            <button tc-button type="button" data-testid="wizard-pick-projects" (click)="pickProjects()">
              {{ 'runners.wizard.online.pickProjects' | transloco }}
            </button>
          </ng-template>
        }
      }
      @case ('ended') {
        <ng-template tcSheetFooter="primary">
          <button
            tc-button
            type="button"
            variant="primary"
            data-testid="wizard-again"
            [loading]="busy() === 'creating'"
            [attr.aria-disabled]="busy() !== null || !online() ? 'true' : null"
            [attr.aria-describedby]="online() ? null : wizardId + '-offline'"
            (click)="again()"
          >
            {{ 'runners.wizard.again' | transloco }}
          </button>
        </ng-template>
        <ng-template tcSheetFooter="secondary">
          <button tc-button type="button" data-testid="wizard-close" (click)="requestClose()">
            {{ 'runners.wizard.close' | transloco }}
          </button>
        </ng-template>
      }
    }
  `,
  styleUrl: './add-runner-wizard.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerWizard {
  protected readonly data = inject<AddRunnerData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<AddRunnerOutcome>>(DialogRef);
  private readonly api = inject(RunnersApi);
  protected readonly watch = inject(EnrolmentWatch);
  protected readonly checks = inject(RunnerCheckFlow);
  private readonly sheet = inject(Sheet);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);

  protected readonly wizardId = `tc-add-runner-${nextWizardId++}`;
  protected readonly isPhone = isPhoneSignal();
  protected readonly lang = this.transloco.getActiveLang();

  protected readonly name = signal('');
  protected readonly scope = signal<RunnerProjectScope>(DEFAULT_RUNNER_PROJECT_SCOPE);
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly platform = signal<RunnerPlatform>('mac');
  protected readonly arch = signal<MacReleasePlatform>('darwin-arm64');
  /** `null` until the members answer, and for good when they fail: the D3 line then stays (decision 5). */
  protected readonly ownerCount = signal<number | null>(null);

  protected readonly phase = signal<Phase>('params');
  /** The step a request ended on, so the indicator does not jump. */
  private readonly endedOn = signal<WizardStep>('command');
  protected readonly ended = signal<WizardEnd>('expired');
  protected readonly created = signal<CreatedIntent | null>(null);
  /** The bound intent as the owner sees it; approve sends this fingerprint, never one read since (R-INT-1). */
  protected readonly shown = signal<EnrolmentIntentDto | null>(null);
  protected readonly busy = signal<Busy | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly offerCode = signal(false);
  protected readonly suspended = signal(false);
  /** False for `APPROVE_ARM_MS` after the shown fingerprint appears or changes (#878 mis-click guard). */
  protected readonly approveArmed = signal(false);
  protected readonly slow = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly online = signal(this.document.defaultView?.navigator.onLine ?? true);
  private readonly touched = signal(false);

  protected readonly runnerName = computed(() => runnerNameOf(this.name()));
  protected readonly nameError = computed((): string | null =>
    this.touched() && this.runnerName() === '' ? this.t('runners.enrol.nameEmpty') : null,
  );
  protected readonly step = computed((): WizardStep => {
    const phase = this.phase();
    return phase === 'ended' ? this.endedOn() : STEP_OF[phase];
  });
  protected readonly pollFailing = computed(
    () => this.watch.failedPolls() >= POLL_FAILURES_SHOWN || this.checks.failedPolls() >= POLL_FAILURES_SHOWN,
  );
  /** A check request that failed as a request (§12.4 «Wizard API errors»): the same §6 banner as the wizard's own. */
  protected readonly checkFailure = computed(() => {
    const key = this.checks.failureKey();
    return key === null ? null : this.t(key);
  });

  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private minuteTimer: ReturnType<typeof setTimeout> | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;
  /** The intent this sheet has already sent a withdraw for, so leaving does not send a second one. */
  private withdrawnId: string | null = null;

  constructor() {
    // Every way out goes through requestClose(): the CDK leaves Escape and the scrim to the frame's guard.
    this.ref.disableClose = true;
    const guard = inject(SheetCloseGuard);
    guard.intercept(() => void this.requestClose());

    const view = this.document.defaultView;
    const onOnline = (): void => this.online.set(true);
    const onOffline = (): void => this.online.set(false);
    view?.addEventListener('online', onOnline);
    view?.addEventListener('offline', onOffline);
    const onPageHide = (): void => this.withdrawLeftBehind();
    view?.addEventListener('pagehide', onPageHide);
    const tick = setInterval(() => this.now.set(Date.now()), COUNTDOWN_TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      // Session expiry and navigation close every sheet without the §3.6 dialog (#878).
      this.withdrawLeftBehind();
      guard.release();
      view?.removeEventListener('online', onOnline);
      view?.removeEventListener('offline', onOffline);
      view?.removeEventListener('pagehide', onPageHide);
      clearInterval(tick);
      this.clearTimers();
      this.clearArmTimer();
    });

    effect(() => {
      const intent = this.watch.intent();
      untracked(() => this.follow(intent));
    });
    effect(() => {
      const stopped = this.watch.stopped();
      untracked(() => this.stoppedWith(stopped));
    });
    effect(() => {
      const online = this.watch.runner()?.online === true;
      if (online) {
        untracked(() => this.cameOnline());
      }
    });

    void this.readOwners();
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() !== null) {
      return;
    }
    this.touched.set(true);
    if (this.runnerName() === '') {
      // The field marks itself invalid on the next render.
      afterNextRender(
        () => this.host.nativeElement.querySelector<HTMLElement>('[data-testid="wizard-name"]')?.focus(),
        {
          injector: this.injector,
        },
      );
      return;
    }
    await this.create();
  }

  /** Decision 1: the one-time-code dialog takes over with what the owner typed. */
  protected toCode(): void {
    this.ref.close({
      kind: 'code',
      name: this.runnerName(),
      projectScope: this.scope(),
      allowedProjects: this.scope() === 'all' ? [] : this.selected(),
    });
  }

  protected async again(): Promise<void> {
    if (this.busy() === null && this.online()) {
      await this.create();
    }
  }

  protected async withdraw(): Promise<void> {
    const created = this.created();
    if (created === null || this.busy() !== null) {
      return;
    }
    this.busy.set('withdrawing');
    const result = await this.api.withdrawEnrolmentIntent(this.data.accountId, created.intentId);
    this.busy.set(null);
    if (!result.ok && result.failure.kind !== 'not-found') {
      this.failure.set(this.t(runnerFailureKeyOf(result.failure)));
      return;
    }
    this.withdrawnId = created.intentId;
    this.watch.stop();
    this.created.set(null);
    this.failure.set(null);
    this.phase.set('params');
    this.announce('runners.wizard.withdrawn.self');
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('[data-testid="wizard-name"]')?.focus(),
      {
        injector: this.injector,
      },
    );
  }

  protected async approve(): Promise<void> {
    const created = this.created();
    const shown = this.shown();
    if (
      created === null ||
      shown?.fingerprint == null ||
      this.busy() !== null ||
      !this.online() ||
      this.suspended() ||
      !this.approveArmed()
    ) {
      return;
    }
    this.busy.set('approving');
    this.failure.set(null);
    const result = await this.api.approveEnrolmentIntent(
      this.data.accountId,
      created.intentId,
      shown.fingerprint,
    );
    this.busy.set(null);
    if (result.ok) {
      this.follow(result.value);
      return;
    }
    await this.approveRefused(result.failure);
  }

  /** «Отклонить» withdraws the request: nothing is lost, and the next step is a new command. */
  protected async reject(): Promise<void> {
    const created = this.created();
    if (created === null || this.busy() !== null || !this.online()) {
      return;
    }
    this.busy.set('rejecting');
    this.failure.set(null);
    const result = await this.api.withdrawEnrolmentIntent(this.data.accountId, created.intentId);
    this.busy.set(null);
    if (!result.ok && result.failure.kind !== 'not-found') {
      this.failure.set(this.t(runnerFailureKeyOf(result.failure)));
      return;
    }
    this.withdrawnId = created.intentId;
    this.end('rejected');
  }

  /** One read on the owner's click, once the watch has stopped polling (#878). */
  protected async recheck(): Promise<void> {
    if (this.busy() !== null) {
      return;
    }
    this.busy.set('rechecking');
    await this.watch.checkNow();
    this.busy.set(null);
    if (this.watch.runner()?.online !== true) {
      this.announce('runners.wizard.slow.stillOffline');
    }
  }

  protected pickProjects(): void {
    const runner = this.watch.runner();
    if (runner !== null) {
      this.ref.close({ kind: 'pick-projects', runnerId: runner.id });
    }
  }

  /** The close button, Escape, the scrim, Cancel, Close and Done all land here (spec §3.6). */
  protected async requestClose(): Promise<void> {
    if (this.busy() !== null) {
      return;
    }
    const created = this.created();
    const phase = this.phase();
    if (created === null || (phase !== 'command' && phase !== 'confirm')) {
      this.ref.close({ kind: 'closed', enrolled: phase === 'approved' });
      return;
    }
    const confirmed = await this.sheet.confirm({
      title: this.t('runners.wizard.closeConfirm.title'),
      message: this.t('runners.wizard.closeConfirm.message'),
      confirmLabel: this.t('runners.wizard.closeConfirm.confirm'),
      cancelLabel: this.t('runners.wizard.closeConfirm.stay'),
      tone: 'danger',
    });
    // The request may have moved on while the confirmation was open.
    if (!confirmed || this.busy() !== null) {
      return;
    }
    if (this.phase() !== 'command' && this.phase() !== 'confirm') {
      this.ref.close({ kind: 'closed', enrolled: this.phase() === 'approved' });
      return;
    }
    this.busy.set('withdrawing');
    this.withdrawnId = created.intentId;
    const result = await this.api.withdrawEnrolmentIntent(this.data.accountId, created.intentId);
    this.busy.set(null);
    this.watch.stop();
    if (!result.ok && result.failure.kind !== 'not-found') {
      // It expires on its own in ten minutes; closing anyway leaves nothing that could still be approved here.
      this.toaster.show(this.t('runners.wizard.closeFailed'));
    }
    this.ref.close({ kind: 'closed', enrolled: false });
  }

  private async create(): Promise<void> {
    this.busy.set('creating');
    this.failure.set(null);
    this.offerCode.set(false);
    this.suspended.set(false);
    const scope = this.scope();
    const linux = this.platform() === 'linux';
    const result = await this.api.createEnrolmentIntent(this.data.accountId, {
      name: this.runnerName(),
      projectScope: scope,
      allowedProjects: scope === 'all' ? [] : this.selected(),
      isolation: linux ? 'container' : 'user',
    });
    if (!result.ok) {
      this.busy.set(null);
      this.createRefused(result.failure);
      return;
    }
    const { intentId, expiresAt, command, installCommands, linuxInstall } = result.value;
    if (linux && linuxInstall === null) {
      // No runner image named for the one command yet: the code dialog takes over, as before #634 PR 7.
      await this.dropUnusedIntent(intentId);
      this.busy.set(null);
      this.toCode();
      return;
    }
    this.busy.set(null);
    this.created.set({
      intentId,
      expiresAt,
      setupCommand: command,
      install: installCommands,
      linux: linuxInstall,
    });
    this.shown.set(null);
    this.phase.set('command');
    this.watch.watchIntent(this.data.accountId, intentId, expiresAt);
    this.armExpirySoon(expiresAt);
    this.announce('runners.wizard.live.command');
    this.focusHeading();
  }

  /**
   * 503 `console-origin-misconfigured` (#817): the API has no origin to put in a command and made no request; the
   * code path is offered instead, and the wizard never builds a command itself.
   */
  private createRefused(failure: RunnerFailure): void {
    this.phase.set('params');
    if (failure.slug === 'console-origin-misconfigured') {
      this.failure.set(this.t('runners.wizard.err.noCommand'));
      this.offerCode.set(true);
    } else {
      this.failure.set(
        this.t(failure.kind === 'rate-limited' ? 'runners.wizard.err.hourly' : runnerFailureKeyOf(failure)),
      );
    }
  }

  private async approveRefused(failure: RunnerFailure): Promise<void> {
    if (failure.kind === 'forbidden' && failure.slug === 'account-suspended') {
      this.suspended.set(true);
      this.failure.set(this.t('runners.wizard.err.suspended'));
      return;
    }
    if (failure.kind === 'conflict' || failure.kind === 'not-found') {
      const current = await this.reread();
      if (current === null) {
        this.end('withdrawn');
        return;
      }
      if (current.state === 'bound') {
        // Never approve again on our own: the owner compares the new code first.
        this.showForApproval(current);
        if (failure.kind === 'conflict' && failure.slug !== 'enrolment-intent-not-bound') {
          this.failure.set(this.t('runners.wizard.err.changed'));
        }
        this.focusHeading();
        return;
      }
      this.follow(current);
      return;
    }
    this.failure.set(this.t(runnerFailureKeyOf(failure)));
  }

  private async reread(): Promise<EnrolmentIntentDto | null> {
    const created = this.created();
    if (created === null) {
      return null;
    }
    this.busy.set('rereading');
    const read = await this.api.enrolmentIntent(this.data.accountId, created.intentId);
    this.busy.set(null);
    return read.ok ? read.value : null;
  }

  /** The server's state always wins: every answer about the intent goes through here. */
  private follow(intent: EnrolmentIntentDto | null): void {
    const created = this.created();
    if (intent === null || created === null || intent.id !== created.intentId) {
      return;
    }
    switch (intent.state) {
      case 'pending':
        return;
      case 'bound':
        if (this.phase() === 'command') {
          this.showForApproval(intent);
          this.phase.set('confirm');
          this.announce('runners.wizard.live.bound', {
            host: intent.host?.hostname ?? '',
            fingerprint: fingerprintSpokenOf(
              intent.fingerprint ?? '',
              this.t('runners.wizard.fingerprintDash'),
            ),
          });
          this.focusHeading();
        }
        return;
      case 'approved':
      case 'used':
        if (this.phase() !== 'approved' && intent.runnerId !== null) {
          this.toApproved(intent.runnerId);
        }
        return;
      case 'expired':
      case 'withdrawn':
        if (this.phase() === 'command' || this.phase() === 'confirm') {
          this.end(intent.state);
        }
        return;
    }
  }

  /** Every fingerprint the owner is asked to compare arrives here, so approve waits out the guard each time. */
  private showForApproval(intent: EnrolmentIntentDto): void {
    this.shown.set(intent);
    this.approveArmed.set(false);
    this.clearArmTimer();
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      this.approveArmed.set(true);
    }, APPROVE_ARM_MS);
  }

  /**
   * Best effort for a live request the sheet leaves without the §3.6 dialog: an expired session or navigation closes
   * every sheet, and `pagehide` covers a closed tab (`keepalive` lets the call outlive the page). An approve in flight
   * is left to finish. A failure is only logged: the request cannot be approved from anywhere and expires in ten minutes.
   */
  private withdrawLeftBehind(): void {
    const created = this.created();
    const phase = this.phase();
    if (
      created === null ||
      created.intentId === this.withdrawnId ||
      (phase !== 'command' && phase !== 'confirm') ||
      this.busy() === 'approving'
    ) {
      return;
    }
    // The watch keeps going: back from the back-forward cache, its next read shows «Запрос отозван».
    this.withdrawnId = created.intentId;
    void this.sendWithdrawLeftBehind(created.intentId);
  }

  /**
   * A Linux request the environment has no command for is withdrawn at once, so it does not count against the three
   * open requests. A failure is only logged: nobody has the id, and it expires in ten minutes.
   */
  private async dropUnusedIntent(intentId: string): Promise<void> {
    this.withdrawnId = intentId;
    const result = await this.api.withdrawEnrolmentIntent(this.data.accountId, intentId);
    if (!result.ok && result.failure.kind !== 'not-found') {
      console.warn(
        `add-runner: could not withdraw the unused Linux request (${result.failure.kind}); it expires on its own`,
      );
    }
  }

  private async sendWithdrawLeftBehind(intentId: string): Promise<void> {
    const result = await this.api.withdrawEnrolmentIntent(this.data.accountId, intentId, { keepalive: true });
    if (!result.ok && result.failure.kind !== 'not-found') {
      console.warn(
        `add-runner: could not withdraw a request left open (${result.failure.kind}); it expires on its own`,
      );
    }
  }

  private toApproved(runnerId: string): void {
    this.failure.set(null);
    this.phase.set('approved');
    this.watch.watchRunner(this.data.accountId, runnerId);
    this.clearTimers();
    this.slowTimer = setTimeout(() => this.slow.set(true), SLOW_AFTER_MS);
    this.announce('runners.wizard.live.approved');
    this.focusHeading();
  }

  private cameOnline(): void {
    const runner = this.watch.runner();
    if (this.phase() !== 'approved' || runner === null) {
      return;
    }
    this.clearTimers();
    this.slow.set(false);
    const checking = this.checks.arrive({
      accountId: this.data.accountId,
      runnerId: runner.id,
      platform: this.platform(),
      belowMinimum: runner.belowMinimum,
      browserOnline: this.online(),
    });
    // One announcement for both, so the check's start does not cut the online one off (§12.5).
    this.announce(checking ? 'runners.wizard.live.onlineChecking' : 'runners.wizard.live.online', {
      name: this.runnerName(),
    });
    this.focusHeading();
  }

  /** «Проверить» / «Проверить снова» (#1059 PR 3): not while the browser is offline (§12.4 C0). */
  protected startCheck(): void {
    if (this.online()) {
      void this.checks.press();
    }
  }

  private end(reason: WizardEnd): void {
    this.watch.stop();
    this.clearTimers();
    this.endedOn.set(this.step());
    this.ended.set(reason);
    this.phase.set('ended');
    this.announce(`runners.wizard.${reason}.title`);
    this.focusHeading();
  }

  private stoppedWith(stopped: EnrolmentWatchStop | null): void {
    switch (stopped) {
      case 'session-expired':
        this.failure.set(this.t('runners.err.sessionExpired'));
        return;
      case 'forbidden':
        this.failure.set(this.t('runners.err.forbidden'));
        return;
      case 'not-found':
        if (this.phase() === 'command' || this.phase() === 'confirm') {
          this.end('withdrawn');
        }
        return;
      default:
        return;
    }
  }

  private async readOwners(): Promise<void> {
    const owners = await this.api.ownerCount(this.data.accountId);
    if (owners.ok) {
      this.ownerCount.set(owners.value);
    }
  }

  /** One polite announcement a minute before the request expires; the countdown itself is not live. */
  private armExpirySoon(expiresAt: string): void {
    this.clearTimers();
    const soon = Date.parse(expiresAt) - 60_000 - Date.now();
    if (soon > 0) {
      this.minuteTimer = setTimeout(() => {
        if (this.phase() === 'command' || this.phase() === 'confirm') {
          this.now.set(Date.now());
          this.announce('runners.wizard.expiresSoon');
        }
      }, soon);
    }
  }

  private clearArmTimer(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.slowTimer !== null) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
    if (this.minuteTimer !== null) {
      clearTimeout(this.minuteTimer);
      this.minuteTimer = null;
    }
  }

  /** The old step's content is gone after every flip, polling ones included, so focus goes to the new heading. */
  private focusHeading(): void {
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('[data-step-heading]')?.focus(),
      {
        injector: this.injector,
      },
    );
  }

  private announce(key: string, params?: Record<string, unknown>): void {
    void this.announcer.announce(this.t(key, params), 'polite');
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
