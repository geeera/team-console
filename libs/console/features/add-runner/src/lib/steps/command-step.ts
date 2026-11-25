import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Callout, CopyCode, Segment, SegmentedRadio, Spinner } from '@console/shared/ui';
import {
  LINUX_PODMAN_SOCKET,
  LINUX_RUNNER_USER,
  type LinuxInstallCommandsDto,
  type MacReleasePlatform,
  type RunnerInstallCommandsDto,
} from '@shared/contracts';
import { minutesLeftOf, RUNBOOK_INSTALL_URL } from '../add-runner.model';

let nextCommandId = 0;

/**
 * Step 2 «Команда» (spec §3.2), while the intent is pending. Variant A is the API's verified one-liner for the chosen
 * processor (it exists only for a release that ships its own `node`, S2); variant B is the runbook path with the
 * API's `setup` line. The text is the API's, byte for byte: nothing here assembles or edits a command.
 */
@Component({
  selector: 'tc-add-runner-command-step',
  imports: [Callout, CopyCode, LocalTimePipe, Segment, SegmentedRadio, Spinner, TranslocoPipe],
  template: `
    <h3 class="step__heading" tabindex="-1" data-step-heading>
      {{ (linuxInstall() === null ? 'runners.wizard.command.title' : 'runners.wizard.command.linux.title') | transloco: { name: name() } }}
    </h3>
    @if (isPhone()) {
      <section tc-callout data-testid="wizard-phone-note">
        <p>{{ (linuxInstall() === null ? 'runners.wizard.command.phone' : 'runners.wizard.command.linux.phone') | transloco }}</p>
      </section>
    }
    @if (linuxInstall(); as linux) {
      <p class="step__lead">{{ 'runners.wizard.command.linux.lead' | transloco }}</p>
      <ol class="command__steps" data-testid="wizard-linux">
        <li>
          <span class="step__value">{{ 'runners.wizard.command.linux.prepareTitle' | transloco }}</span>
          <span class="step__meta">{{ 'runners.wizard.command.linux.prepareBody' | transloco }}</span>
          <tc-copy-code
            data-testid="wizard-linux-prepare"
            [code]="linux.prepare"
            [regionLabel]="'runners.wizard.command.linux.prepareRegion' | transloco"
            [ariaLabel]="'runners.wizard.command.linux.prepareCopyAria' | transloco"
            [copyLabel]="'runners.enrol.copy' | transloco"
            [copiedLabel]="'runners.enrol.copied' | transloco"
            [failedNote]="'runners.enrol.copyFailed' | transloco"
          />
        </li>
        <li>
          <span class="step__value">{{ 'runners.wizard.command.linux.enrolTitle' | transloco }}</span>
          <span class="step__meta">{{ 'runners.wizard.command.linux.enrolBody' | transloco }}</span>
          <tc-copy-code
            data-testid="wizard-command"
            [code]="linux.enrol"
            [regionLabel]="'runners.wizard.command.linux.enrolRegion' | transloco"
            [ariaLabel]="'runners.wizard.command.linux.enrolCopyAria' | transloco"
            [copyLabel]="'runners.enrol.copy' | transloco"
            [copiedLabel]="'runners.enrol.copied' | transloco"
            [failedNote]="'runners.enrol.copyFailed' | transloco"
          />
        </li>
      </ol>
      <section tc-callout data-testid="wizard-linux-socket">
        <p>{{ 'runners.wizard.command.linux.socket' | transloco: { user: linuxUser, socket: podmanSocket } }}</p>
      </section>
      <details class="command__what">
        <summary>{{ 'runners.wizard.command.what' | transloco }}</summary>
        <p class="step__meta">
          {{ 'runners.wizard.command.linux.whatBody' | transloco: { version: linux.version, image: linux.image } }}
        </p>
      </details>
    } @else if (installCommands(); as install) {
      <p class="step__lead">{{ 'runners.wizard.command.leadOneLiner' | transloco }}</p>
      <fieldset tc-segmented [legend]="'runners.wizard.command.arch' | transloco">
        @for (option of archOptions; track option.value) {
          <label tc-segment>
            <input
              type="radio"
              [name]="groupId + '-arch'"
              [value]="option.value"
              [attr.data-testid]="'wizard-arch-' + option.value"
              [checked]="arch() === option.value"
              [attr.aria-describedby]="groupId + '-arch-hint'"
              (change)="arch.set(option.value)"
            />
            {{ option.label | transloco }}
          </label>
        }
        <p tc-segmented-hint [id]="groupId + '-arch-hint'">{{ 'runners.wizard.command.archHint' | transloco }}</p>
      </fieldset>
      <tc-copy-code
        data-testid="wizard-command"
        [code]="install[arch()]"
        [regionLabel]="'runners.wizard.command.region' | transloco"
        [ariaLabel]="'runners.wizard.command.copyAria' | transloco"
        [copyLabel]="'runners.enrol.copy' | transloco"
        [copiedLabel]="'runners.enrol.copied' | transloco"
        [failedNote]="'runners.enrol.copyFailed' | transloco"
      />
      <details class="command__what">
        <summary>{{ 'runners.wizard.command.what' | transloco }}</summary>
        <p class="step__meta">{{ 'runners.wizard.command.whatBody' | transloco: { version: install.version } }}</p>
      </details>
    } @else {
      <p class="step__lead">{{ 'runners.wizard.command.leadRunbook' | transloco }}</p>
      <ol class="command__steps" data-testid="wizard-runbook">
        <li>
          {{ 'runners.wizard.command.runbookStep1' | transloco: { version: releaseVersion() ?? '' } }}
          <a [href]="runbookUrl" target="_blank" rel="noopener noreferrer" data-testid="wizard-runbook-link"
            >{{ 'runners.wizard.command.runbookLink' | transloco }} ↗<span class="tc-sr-only">
              {{ 'runners.wizard.newTab' | transloco }}</span
            ></a
          >
        </li>
        <li>
          {{ 'runners.wizard.command.runbookStep2' | transloco }}
          <tc-copy-code
            data-testid="wizard-command"
            [code]="setupCommand()"
            [regionLabel]="'runners.wizard.command.region' | transloco"
            [ariaLabel]="'runners.wizard.command.copyAria' | transloco"
            [copyLabel]="'runners.enrol.copy' | transloco"
            [copiedLabel]="'runners.enrol.copied' | transloco"
            [failedNote]="'runners.enrol.copyFailed' | transloco"
          />
        </li>
      </ol>
    }
    <p class="step__meta">{{ 'runners.wizard.command.noSecrets' | transloco }}</p>
    <p class="step__meta" data-testid="wizard-expiry">
      {{ 'runners.wizard.expires' | transloco: { time: expiresAt() | localTime, minutes: minutesLeft() } }}
    </p>
    <div class="step__wait" data-testid="wizard-waiting">
      <tc-spinner />
      <div>
        <p class="step__value">{{ 'runners.wizard.waiting' | transloco }}</p>
        <p class="step__meta">{{ 'runners.wizard.waitingSub' | transloco }}</p>
      </div>
    </div>
  `,
  styleUrl: './add-runner-step.css',
  styles: `
    /* min-width: 0 keeps a long command scrolling inside its own region instead of widening the sheet. */
    .command__steps {
      display: grid;
      min-width: 0;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
      margin: 0;
      padding-inline-start: var(--space-5);
    }

    .command__steps li {
      display: grid;
      min-width: 0;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
    }

    .command__what summary {
      min-height: var(--control-h-touch);
      display: flex;
      align-items: center;
      cursor: pointer;
    }

    .step__wait p {
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerCommandStep {
  readonly name = input.required<string>();
  /** The `setup` line for a Mac with the release installed (variant B). */
  readonly setupCommand = input.required<string>();
  /** The verified-download one-liners; `null` puts the runbook path on screen (variant B). */
  readonly installCommands = input<RunnerInstallCommandsDto | null>(null);
  /** The Linux one command (#634 PR 7): prepare once, then the interactive enrol step. Wins over both Mac variants. */
  readonly linuxInstall = input<LinuxInstallCommandsDto | null>(null);
  /** The release the environment names, for variant B's first step. */
  readonly releaseVersion = input<string | null>(null);
  readonly expiresAt = input.required<string>();
  /** `Date.now()` of the last countdown tick. */
  readonly now = input.required<number>();
  readonly isPhone = input(false);
  readonly arch = model<MacReleasePlatform>('darwin-arm64');

  protected readonly groupId = `tc-add-runner-command-${nextCommandId++}`;
  protected readonly runbookUrl = RUNBOOK_INSTALL_URL;
  protected readonly linuxUser = LINUX_RUNNER_USER;
  protected readonly podmanSocket = LINUX_PODMAN_SOCKET;
  protected readonly archOptions: readonly { readonly value: MacReleasePlatform; readonly label: string }[] = [
    { value: 'darwin-arm64', label: 'runners.wizard.command.archArm' },
    { value: 'darwin-x64', label: 'runners.wizard.command.archIntel' },
  ];
  protected readonly minutesLeft = computed(() => minutesLeftOf(this.expiresAt(), this.now()));
}
