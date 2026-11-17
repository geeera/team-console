import { LiveAnnouncer } from '@angular/cdk/a11y';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { EnvironmentStatusState } from '@console/entities/environment';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoPluralPipe } from '@console/shared/i18n';
import { Button, CopyCode, Icon } from '@console/shared/ui';
import type { Environment } from '@shared/contracts';
import { setupCommandOf } from '@shared/environment';

let nextSummaryId = 0;

/**
 * The summary slip of one environment (#104, reused by #750's project sections): the count and the one fix command,
 * Go to the first missing one and Check again — or, where this console cannot see, the `--check` command; the error,
 * offline and rate states before an answer. Its texts come from the screen (the operator's or a project's); Check
 * again announces the new heading once and, after an error, moves focus to it.
 */
@Component({
  selector: 'tc-environment-summary',
  imports: [Button, CopyCode, Icon, LocalTimePipe, NgTemplateOutlet, TranslocoPipe, TranslocoPluralPipe],
  templateUrl: './environment-summary.html',
  styleUrl: './environment-summary.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnvironmentSummary {
  private readonly injector = inject(Injector);
  private readonly announcer = inject(LiveAnnouncer);
  protected readonly network = inject(NetworkStatus);

  readonly status = input.required<EnvironmentStatusState>();
  readonly environment = input.required<Environment>();
  /** Whether the rows are this console's own, so set and missing are known. */
  readonly isThisConsole = input.required<boolean>();
  /** The required missing rows: the count, and whether the fix command shows. */
  readonly missing = input.required<number>();
  /** Rows only `setup --check` can see (the operator screen). */
  readonly unseen = input(0);
  /** Optional rows not set (a project's section): a plain line, never a warning. */
  readonly optionalMissing = input(0);
  /** The heading as it reads now (missing or all set), already translated. */
  readonly title = input.required<string>();
  readonly missingBody = input.required<string>();
  /** The line of an environment this console cannot see, already translated. */
  readonly otherLine = input('');
  readonly errorTitle = input.required<string>();
  /** The operator screen's summary is an h2; a project section's is an h3 under the section's h2 (#750). */
  readonly headingLevel = input<2 | 3>(2);

  /** "Go to the first missing one". */
  readonly jump = output<void>();

  protected readonly id = `env-sum-${nextSummaryId++}`;
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly checking = computed(() => this.status().state() === 'loading');
  protected readonly problem = computed(() => this.status().problem());
  protected readonly hasAnswer = computed(() => this.status().snapshot() !== null);
  protected readonly checkedAt = computed(() => this.status().checkedAt());
  protected readonly rateUntil = computed(() => {
    const problem = this.problem();
    return problem?.kind === 'rate' ? problem.retryAt : null;
  });
  /** Why Check again is off, if it is (UX spec: `aria-disabled` with the reason, never `disabled`). */
  protected readonly recheckOff = computed(
    () => this.checking() || !this.network.online() || this.rateUntil() !== null,
  );
  protected readonly setCommand = computed(() => setupCommandOf(this.environment()));
  protected readonly checkCommand = computed(() => setupCommandOf(this.environment(), 'check'));

  focusHeading(): void {
    this.heading()?.nativeElement.focus();
  }

  protected onJump(event: Event): void {
    event.preventDefault();
    this.jump.emit();
  }

  protected async recheck(): Promise<void> {
    if (this.recheckOff()) {
      return;
    }
    const hadAnswer = this.hasAnswer();
    const status = this.status();
    await status.load();
    if (status.state() !== 'ready') {
      return;
    }
    afterNextRender(
      () => {
        if (!hadAnswer) {
          this.focusHeading();
        }
        void this.announcer.announce(this.title(), 'polite');
      },
      { injector: this.injector },
    );
  }
}
