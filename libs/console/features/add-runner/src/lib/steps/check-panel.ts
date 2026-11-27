import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { localTimeOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, CopyCode, Icon, Spinner } from '@console/shared/ui';
import {
  CLAUDE_INSTALL_COMMAND,
  LINUX_LOG_COMMAND,
  LINUX_STATUS_COMMAND,
  RUNBOOK_LINUX_URL,
  RUNBOOK_UPDATE_URL,
  RUNNER_LOG_PATH,
  SELF_CHECK_COMMAND,
  SETUP_CREDENTIAL_COMMAND,
  SETUP_TOOLCHAIN_COMMAND,
  type RunnerPlatform,
} from '../add-runner.model';
import {
  checkTitleKeyOf,
  checkToneOf,
  isCheckInFlight,
  offersCheckRetry,
  type CheckView,
} from '../check-panel.model';

/** Stands in for `{{version}}` while the sentence is split around it; never in a translation. */
const VERSION_SLOT = '';

let nextPanelId = 0;

/**
 * «Проверка раннера» on step 4b (#1059 PR 3, UX §12.3–12.6): one state at a time, C0–C9, with the fix for the
 * runner's platform and one retry button that stays in place (`aria-disabled`, never `disabled`), so focus never
 * drops while a check runs. Presentational: the wizard's `RunnerCheckFlow` decides the state. Nothing from the wire
 * is rendered but `claudeVersion`, as a text node inside `<bdi>`; a failure is a result, never a `danger` callout.
 */
@Component({
  selector: 'tc-add-runner-check-panel',
  imports: [Button, Callout, CopyCode, Icon, NgTemplateOutlet, Spinner, TranslocoPipe],
  template: `
    <section
      class="check"
      data-testid="wizard-check"
      [attr.data-state]="view().kind"
      [attr.aria-labelledby]="panelId + '-heading'"
      [attr.aria-busy]="inFlight() ? 'true' : null"
    >
      <h4 class="check__heading" tabindex="-1" #heading [id]="panelId + '-heading'">
        {{ 'runners.wizard.check.heading' | transloco }}
      </h4>
      @if (tone(); as tone) {
        <div tc-callout class="check__result" [tone]="tone">
          <ng-container *ngTemplateOutlet="state" />
        </div>
      } @else {
        <div class="check__result">
          <ng-container *ngTemplateOutlet="state" />
        </div>
      }
      @if (showsRetry()) {
        <p class="check__retry">
          <button
            #retry
            tc-button
            size="sm"
            type="button"
            data-testid="wizard-check-start"
            [loading]="inFlight()"
            [attr.aria-disabled]="retryDisabled() ? 'true' : null"
            [attr.aria-describedby]="retryReasonId()"
            (click)="press()"
          >
            {{ retryLabelKey() | transloco }}
          </button>
          @if (!browserOnline()) {
            <span class="tc-sr-only" [id]="panelId + '-offline'">{{
              'runners.wizard.offlineReason' | transloco
            }}</span>
          }
        </p>
      }
    </section>

    <ng-template #state>
      <p
        class="check__status"
        data-testid="wizard-check-title"
        [id]="panelId + '-status'"
        [class.check__status--plain]="view().kind === 'idle'"
      >
        @if (inFlight()) {
          <tc-spinner />
        } @else if (view().kind === 'passed') {
          <tc-icon name="check" size="sm" />
        } @else if (tone() !== null) {
          <tc-icon name="alert" size="sm" />
        }
        <span>{{ title() }}</span>
      </p>
      @switch (view().kind) {
        @case ('queued') {
          <p class="check__line">
            {{ (queuedSlow() ? 'runners.wizard.check.queuedSlow' : 'runners.wizard.check.queuedSub') | transloco }}
          </p>
        }
        @case ('running') {
          <p class="check__line">{{ 'runners.wizard.check.runningSub' | transloco }}</p>
        }
        @case ('passed') {
          <p class="check__line" data-testid="wizard-check-passed">
            @if (version(); as version) {
              {{ passedSentence()[0] }}<bdi dir="auto" data-testid="wizard-check-version">{{ version }}</bdi
              >{{ passedSentence()[1] }}
            } @else {
              {{ passedSentence()[0].trimEnd() }}{{ passedSentence()[1] }}
            }
          </p>
          <p class="check__line check__quiet">{{ 'runners.wizard.check.passed.note' | transloco }}</p>
        }
        @case ('offline') {
          <p class="check__line">{{ 'runners.wizard.check.offline.' + cause() | transloco }}</p>
          <p class="check__line">{{ 'runners.wizard.check.offline.fix' | transloco }}</p>
          <ng-container *ngTemplateOutlet="machineFix" />
          @if (cause() === 'notPickedUp') {
            <p class="check__line">
              {{ 'runners.wizard.check.offline.update' | transloco }}
              <ng-container *ngTemplateOutlet="updateLink" />
            </p>
          }
        }
        @case ('claude') {
          <p class="check__line">{{ 'runners.wizard.check.claude.' + cause() | transloco }}</p>
          <p class="check__line">{{ 'runners.wizard.check.claude.fix' + platformSuffix() | transloco }}</p>
          @if (platform() === 'linux') {
            <ng-container *ngTemplateOutlet="linuxLink" />
          } @else {
            <tc-copy-code
              data-testid="wizard-check-toolchain"
              [code]="claudeInstall"
              [regionLabel]="'runners.wizard.check.region.toolchain' | transloco"
              [ariaLabel]="'runners.wizard.check.copyAria.toolchain' | transloco"
              [copyLabel]="'runners.enrol.copy' | transloco"
              [copiedLabel]="'runners.enrol.copied' | transloco"
              [failedNote]="'runners.enrol.copyFailed' | transloco"
            />
            <ng-container *ngTemplateOutlet="setupFix; context: { $implicit: setupToolchain }" />
          }
        }
        @case ('credential') {
          <p class="check__line">
            {{ 'runners.wizard.check.credential.' + cause() + platformSuffix() | transloco }}
          </p>
          <p class="check__line">
            {{ 'runners.wizard.check.credential.fix' + platformSuffix() | transloco }}
          </p>
          @if (platform() === 'linux') {
            <ng-container *ngTemplateOutlet="linuxLink" />
          } @else {
            <ng-container *ngTemplateOutlet="setupFix; context: { $implicit: setupCredential }" />
          }
        }
        @case ('host') {
          <p class="check__line">{{ 'runners.wizard.check.host.body' + platformSuffix() | transloco }}</p>
          <ng-container *ngTemplateOutlet="machineFix" />
        }
        @case ('unknown') {
          <p class="check__line">{{ 'runners.wizard.check.unknown.body' | transloco }}</p>
        }
        @case ('outdated') {
          <p class="check__line">{{ 'runners.wizard.check.outdated.body' | transloco }}</p>
          <p class="check__line"><ng-container *ngTemplateOutlet="updateLink" /></p>
        }
        @case ('idle') {}
        @case ('starting') {}
        @case ('rateLimited') {}
        @default {
          <p class="check__line">{{ 'runners.wizard.check.' + view().kind + '.body' | transloco }}</p>
        }
      }
    </ng-template>

    <ng-template #machineFix>
      <tc-copy-code
        data-testid="wizard-check-self-check"
        [code]="selfCheck()"
        [regionLabel]="'runners.wizard.slow.region' | transloco"
        [ariaLabel]="'runners.wizard.slow.copyAria' | transloco"
        [copyLabel]="'runners.enrol.copy' | transloco"
        [copiedLabel]="'runners.enrol.copied' | transloco"
        [failedNote]="'runners.enrol.copyFailed' | transloco"
      />
      <p class="check__line">{{ 'runners.wizard.slow.log' | transloco: { path: logPath() } }}</p>
    </ng-template>

    <ng-template #setupFix let-command>
      <tc-copy-code
        data-testid="wizard-check-setup"
        [code]="command"
        [regionLabel]="'runners.wizard.check.region.setup' | transloco"
        [ariaLabel]="'runners.wizard.check.copyAria.setup' | transloco"
        [copyLabel]="'runners.enrol.copy' | transloco"
        [copiedLabel]="'runners.enrol.copied' | transloco"
        [failedNote]="'runners.enrol.copyFailed' | transloco"
      />
    </ng-template>

    <ng-template #linuxLink>
      <p class="check__line">
        <a [href]="linuxUrl" target="_blank" rel="noopener noreferrer"
          >{{ 'runners.wizard.check.claude.linuxLink' | transloco }} ↗<span class="tc-sr-only">
            {{ 'runners.wizard.newTab' | transloco }}</span
          ></a
        >
      </p>
    </ng-template>

    <ng-template #updateLink>
      <a [href]="updateUrl" target="_blank" rel="noopener noreferrer" data-testid="wizard-check-update"
        >{{ 'runners.wizard.online.update' | transloco }} ↗<span class="tc-sr-only">
          {{ 'runners.wizard.newTab' | transloco }}</span
        ></a
      >
    </ng-template>
  `,
  styleUrl: './check-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerCheckPanel {
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);

  readonly view = input.required<CheckView>();
  readonly platform = input<RunnerPlatform>('mac');
  /** Whether this caller may start a check: an owner of the account (a 403 takes it away, §6 state 20). */
  readonly canStart = input(true);
  readonly browserOnline = input(true);
  /** C9: false until the 429's `Retry-After` has passed; the button stays where it is, `aria-disabled`. */
  readonly retryReady = input(true);
  /** C2's sub-line after `CHECK_QUEUED_SLOW_MS` in `queued`. */
  readonly queuedSlow = input(false);
  readonly start = output();

  protected readonly panelId = `tc-check-panel-${nextPanelId++}`;
  protected readonly claudeInstall = CLAUDE_INSTALL_COMMAND;
  protected readonly setupToolchain = SETUP_TOOLCHAIN_COMMAND;
  protected readonly setupCredential = SETUP_CREDENTIAL_COMMAND;
  protected readonly linuxUrl = RUNBOOK_LINUX_URL;
  protected readonly updateUrl = RUNBOOK_UPDATE_URL;

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly retry = viewChild<ElementRef<HTMLElement>>('retry');

  protected readonly inFlight = computed(() => isCheckInFlight(this.view()));
  protected readonly tone = computed(() => checkToneOf(this.view()));
  protected readonly platformSuffix = computed(() => (this.platform() === 'linux' ? 'Linux' : 'Mac'));
  protected readonly showsRetry = computed(() => this.canStart() && offersCheckRetry(this.view()));
  protected readonly retryDisabled = computed(
    () => this.inFlight() || !this.browserOnline() || !this.retryReady(),
  );
  protected readonly retryLabelKey = computed(() => {
    const kind = this.view().kind;
    if (this.inFlight()) {
      return 'runners.wizard.check.busy';
    }
    return kind === 'idle' ? 'runners.wizard.check.start' : 'runners.wizard.check.again';
  });
  protected readonly retryReasonId = computed((): string | null => {
    if (!this.browserOnline()) {
      return `${this.panelId}-offline`;
    }
    return this.view().kind === 'rateLimited' ? `${this.panelId}-status` : null;
  });
  protected readonly cause = computed(() => {
    const view = this.view();
    return 'cause' in view ? view.cause : '';
  });
  protected readonly version = computed(() => {
    const view = this.view();
    return view.kind === 'passed' ? view.version : null;
  });
  protected readonly title = computed(() => {
    const view = this.view();
    const key = checkTitleKeyOf(view, this.platform());
    return view.kind === 'rateLimited'
      ? this.transloco.translate(key, { time: localTimeOf(view.until, this.transloco.getActiveLang()) })
      : this.transloco.translate(key);
  });
  /** The pass sentence as text around the version, so the version alone sits in `<bdi>` (N11). */
  protected readonly passedSentence = computed((): readonly [string, string] => {
    const sentence = this.transloco.translate(`runners.wizard.check.passed.body${this.platformSuffix()}`, {
      version: VERSION_SLOT,
    });
    const [before = '', after = ''] = sentence.split(VERSION_SLOT);
    return [before, after];
  });
  protected readonly selfCheck = computed(() =>
    this.platform() === 'linux' ? LINUX_STATUS_COMMAND : SELF_CHECK_COMMAND,
  );
  protected readonly logPath = computed(() =>
    this.platform() === 'linux' ? LINUX_LOG_COMMAND : RUNNER_LOG_PATH,
  );

  constructor() {
    // §12.5: in C7 revoked, C7 unsupported and C8 the button goes; focus on it moves to the panel's heading.
    effect(() => {
      if (this.showsRetry()) {
        return;
      }
      untracked(() => {
        const button = this.retry()?.nativeElement;
        if (button !== undefined && button.ownerDocument.activeElement === button) {
          afterNextRender(() => this.heading().nativeElement.focus(), { injector: this.injector });
        }
      });
    });
  }

  protected press(): void {
    if (!this.retryDisabled()) {
      this.start.emit();
    }
  }
}
