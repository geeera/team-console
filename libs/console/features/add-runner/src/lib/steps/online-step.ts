import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Callout, CopyCode, Receipt, Spinner } from '@console/shared/ui';
import type { RunnerDto, RunnerProjectScope } from '@shared/contracts';
import {
  LINUX_LOG_COMMAND,
  LINUX_STATUS_COMMAND,
  RUNBOOK_UPDATE_URL,
  RUNNER_LOG_PATH,
  SELF_CHECK_COMMAND,
  type RunnerPlatform,
} from '../add-runner.model';

/**
 * Step 4 «На связи» (spec §3.4–3.5): after the approval, waiting for the first signal (with what to check once it
 * takes longer than five minutes, decision 4), then the runner on line. The console cannot see `self-check`'s
 * output, so the step says where to look on the machine. Once the watch gives up (#878), a re-check is the owner's.
 */
@Component({
  selector: 'tc-add-runner-online-step',
  imports: [Button, Callout, CopyCode, Receipt, Spinner, TranslocoPipe],
  template: `
    @if (runner()?.online) {
      <tc-receipt tone="positive" flush>
        <h3 tc-receipt-verb class="step__heading" tabindex="-1" data-step-heading>
          {{ 'runners.wizard.online.title' | transloco }}
        </h3>
      </tc-receipt>
      <p class="step__lead" data-testid="wizard-online">{{ 'runners.wizard.online.body' | transloco: { name: name() } }}</p>
      <p class="step__meta" data-testid="wizard-online-scope">
        @if (projectScope() === 'all') {
          {{ 'runners.enrol.scopeAll' | transloco }}
        } @else if (allowedProjects().length > 0) {
          {{ 'runners.enrol.projects' | transloco: { projects: allowedProjects().join(', ') } }}
        } @else {
          {{ 'runners.enrol.noProjects' | transloco }}
        }
      </p>
      <p class="step__meta">{{ 'runners.wizard.online.selfCheck' | transloco }}</p>
      @if (runner()?.belowMinimum) {
        <section tc-callout tone="warning" data-testid="wizard-behind">
          <p>
            {{ 'runners.wizard.online.behind' | transloco: { version: runner()?.version, minimum: minimumVersion() ?? '' } }}
          </p>
          <p>
            <a [href]="updateUrl" target="_blank" rel="noopener noreferrer"
              >{{ 'runners.wizard.online.update' | transloco }} ↗<span class="tc-sr-only">
                {{ 'runners.wizard.newTab' | transloco }}</span
              ></a
            >
          </p>
        </section>
      }
    } @else {
      <h3 class="step__heading" tabindex="-1" data-step-heading>{{ 'runners.wizard.approved.title' | transloco }}</h3>
      <p class="step__lead">
        {{ (platform() === 'linux' ? 'runners.wizard.approved.bodyLinux' : 'runners.wizard.approved.body') | transloco }}
      </p>
      @if (!gaveUp()) {
        <div class="step__wait" data-testid="wizard-approved-waiting">
          <tc-spinner />
          <span>{{ 'runners.wizard.approved.waiting' | transloco }}</span>
        </div>
      }
      @if (slow() || gaveUp()) {
        <section tc-callout tone="warning" data-testid="wizard-slow">
          <p tc-callout-title>{{ 'runners.wizard.slow.title' | transloco }}</p>
          <p>{{ 'runners.wizard.slow.body' | transloco }}</p>
          <tc-copy-code
            [code]="selfCheck()"
            [regionLabel]="'runners.wizard.slow.region' | transloco"
            [ariaLabel]="'runners.wizard.slow.copyAria' | transloco"
            [copyLabel]="'runners.enrol.copy' | transloco"
            [copiedLabel]="'runners.enrol.copied' | transloco"
            [failedNote]="'runners.enrol.copyFailed' | transloco"
          />
          <p>{{ 'runners.wizard.slow.log' | transloco: { path: logPath() } }}</p>
          @if (gaveUp()) {
            <p data-testid="wizard-stopped">{{ 'runners.wizard.slow.stopped' | transloco }}</p>
            <p>
              <button
                tc-button
                size="sm"
                type="button"
                data-testid="wizard-recheck"
                [loading]="rechecking()"
                [attr.aria-disabled]="rechecking() ? 'true' : null"
                (click)="recheck.emit()"
              >
                @if (rechecking()) {
                  {{ 'runners.wizard.slow.rechecking' | transloco }}
                } @else {
                  {{ 'runners.wizard.slow.recheck' | transloco }}
                }
              </button>
            </p>
          } @else {
            <p>{{ 'runners.wizard.slow.keepWaiting' | transloco }}</p>
          }
        </section>
      }
    }
  `,
  styleUrl: './add-runner-step.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRunnerOnlineStep {
  readonly name = input.required<string>();
  /** The runner as `GET …/runners` last showed it; `null` until the list has it. */
  readonly runner = input<RunnerDto | null>(null);
  readonly slow = input(false);
  readonly minimumVersion = input<string | null>(null);
  readonly projectScope = input<RunnerProjectScope>('all');
  readonly allowedProjects = input<readonly string[]>([]);
  /** The watch stopped polling (`RUNNER_WATCH_LIMIT_MS`): the callout offers a re-check instead of waiting on. */
  readonly gaveUp = input(false);
  readonly rechecking = input(false);
  readonly recheck = output();

  /** Linux (#634 PR 7) checks both services with systemd; the Mac runs `self-check`. */
  readonly platform = input<RunnerPlatform>('mac');

  protected readonly selfCheck = computed(() => (this.platform() === 'linux' ? LINUX_STATUS_COMMAND : SELF_CHECK_COMMAND));
  protected readonly logPath = computed(() => (this.platform() === 'linux' ? LINUX_LOG_COMMAND : RUNNER_LOG_PATH));
  protected readonly updateUrl = RUNBOOK_UPDATE_URL;
}
