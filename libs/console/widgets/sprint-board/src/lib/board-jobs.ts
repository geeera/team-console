import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { JobCard, jobFailureKeyOf, JobsStore, runnerLabelOf, type JobFailure } from '@console/entities/job';
import { projectActionsRouteOf } from '@console/entities/project';
import { RunNow, type RunNowWait } from '@console/features/run-now';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Callout, Icon, injectRetryFocus, StateBlock } from '@console/shared/ui';
import type { JobDto, RunnerDto, RunnerPauseReason } from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import { BoardJobsNone, type JobsNoneKind } from './board-jobs-none';

/** The pause of the runners that serve the project, as the owner's line words it: the reason and a local time. */
export interface JobsPauseLine {
  readonly reason: RunnerPauseReason;
  readonly time: string;
}

/**
 * A name for a sentence (#775, R-INT-7): invisible and bidi controls dropped, then wrapped in a first-strong isolate,
 * so a right-to-left runner or project name never reorders the words around it. Text only, never markup.
 */
export function isolatedName(name: string): string {
  return `⁨${withoutInvisibles(name)}⁩`;
}

/**
 * The board's «Team jobs» (#464, #775): on every project a runner may serve, whatever its tracker. Above the lists, by
 * `runnerAvailability` and the caller's role on this project: the owner's Run now (with an offline or paused line
 * above it), the member's one line, or the «no runner» block instead of the form. The form waits until availability
 * is known, so it never flashes before a «no runner» block. Then the jobs a runner holds and the queue, then the last
 * jobs that ended. Reads the board's `JobsStore`; runner names, the pause and the D3 runner come from the caller, who
 * reads the account's runners.
 */
@Component({
  selector: 'tc-board-jobs',
  imports: [BoardJobsNone, Button, Callout, Icon, JobCard, RouterLink, RunNow, StateBlock, TranslocoPipe],
  template: `
    <h3 #heading class="board-jobs__heading" tabindex="-1">{{ 'jobs.view.title' | transloco }}</h3>

    @if (isLoading()) {
      <tc-state-block
        kind="loading"
        compact
        data-testid="jobs-loading"
        [title]="'jobs.view.loading' | transloco"
      />
    } @else {
      @if (noneKind(); as none) {
        <tc-board-jobs-none
          [kind]="none"
          [projectName]="projectLabel()"
          [runnerName]="d3RunnerLabel()"
          [people]="nonePeople()"
        />
      } @else {
        <!-- One polite region: a change from ready to offline on refresh is announced once. -->
        <div
          class="board-jobs__availability"
          role="status"
          data-testid="jobs-availability"
          [attr.data-availability]="store.availability()"
        >
          @switch (store.availability()) {
            @case ('offline') {
              <div tc-callout tone="warning" class="board-jobs__line">
                <p>
                  <tc-icon name="offline" size="sm" />
                  <strong>{{ 'jobs.availability.offlineLead' | transloco }}</strong
                  >&ngsp;
                  @if (canRun()) {
                    {{ 'jobs.availability.offlineOwner' | transloco }}&ngsp;<a
                      routerLink="/settings/runners"
                      data-testid="jobs-availability-runners"
                      >{{ 'jobs.availability.runners' | transloco }}</a
                    >
                  } @else {
                    {{ 'jobs.availability.offlineMember' | transloco }}
                  }
                </p>
              </div>
            }
            @case ('paused') {
              <div tc-callout tone="warning" class="board-jobs__line">
                <p>
                  <tc-icon name="pause" size="sm" />
                  @if (ownerPause(); as pause) {
                    <strong>{{
                      'jobs.availability.pausedUntil.' + pause.reason | transloco: { time: pause.time }
                    }}</strong
                    >&ngsp;
                    {{ 'jobs.availability.pausedOwner' | transloco }}
                  } @else {
                    <strong>{{ 'jobs.availability.pausedLead' | transloco }}</strong
                    >&ngsp;
                    {{ 'jobs.availability.pausedMember' | transloco }}
                  }
                </p>
              </div>
            }
          }
        </div>
        @if (showsRunNow()) {
          <tc-run-now
            class="board-jobs__run-now"
            [slug]="slug()"
            [waiting]="waitsFor()"
            (enqueued)="onEnqueued($event)"
          />
        } @else if (store.status() === 'ready') {
          <p class="board-jobs__member" data-testid="jobs-member-line">
            <tc-icon name="lock" size="sm" />
            <span dir="auto">{{
              ownersLabel() === ''
                ? ('jobs.member.line' | transloco)
                : ('jobs.member.lineNamed' | transloco: { owners: ownersLabel() })
            }}</span>
          </p>
        }
      }

      @switch (store.status()) {
        @case ('forbidden') {
          <tc-state-block
            kind="empty"
            compact
            icon="lock"
            data-testid="jobs-forbidden"
            [title]="'jobs.view.forbiddenTitle' | transloco"
            [description]="'jobs.view.forbiddenHint' | transloco"
          />
        }
        @case ('error') {
          <tc-state-block
            kind="error"
            compact
            data-testid="jobs-error"
            [title]="'jobs.view.errorTitle' | transloco"
            [description]="failureKey(store.failure()) | transloco"
          >
            <button tc-button tc-state-action type="button" (click)="refresh()">
              {{ 'ui.error.retry' | transloco }}
            </button>
          </tc-state-block>
        }
        @case ('ready') {
          <div class="board-jobs__head">
            <h4 class="board-jobs__title">{{ 'jobs.view.current' | transloco }}</h4>
            <button
              tc-button
              size="sm"
              variant="quiet"
              type="button"
              class="board-jobs__refresh"
              data-testid="jobs-refresh"
              [loading]="store.refreshing()"
              (click)="refresh()"
            >
              <tc-icon name="refresh" size="sm" />
              {{ 'jobs.view.refresh' | transloco }}
            </button>
          </div>
          @if (store.failure(); as stale) {
            <p class="board-jobs__note" role="status" data-testid="jobs-stale">
              {{ 'jobs.view.staleNote' | transloco }} {{ failureKey(stale) | transloco }}
            </p>
          }
          @if (store.current().length > 0) {
            <ul class="board-jobs__list" data-testid="jobs-current">
              @for (job of store.current(); track job.id) {
                <li>
                  <tc-job-card
                    [job]="job"
                    [runnerName]="runnerOf(job)"
                    [events]="store.eventsOf(job.id)"
                    [eventsFailed]="store.eventFailures().has(job.id)"
                    [actionsSetupLink]="actionsSetupLink()"
                  />
                </li>
              }
            </ul>
          } @else {
            <tc-state-block
              kind="empty"
              compact
              data-testid="jobs-empty"
              [title]="'jobs.view.empty' | transloco"
              [description]="
                (canRun() && noneKind() === null ? 'jobs.view.emptyHint' : 'jobs.view.emptyHintMember')
                  | transloco
              "
            />
          }
          <h4 class="board-jobs__title">{{ 'jobs.view.recent' | transloco }}</h4>
          @if (store.recent().length > 0) {
            <ul class="board-jobs__list" data-testid="jobs-recent">
              @for (job of store.recent(); track job.id) {
                <li>
                  <tc-job-card
                    [job]="job"
                    [runnerName]="runnerOf(job)"
                    [events]="store.eventsOf(job.id)"
                    [actionsSetupLink]="actionsSetupLink()"
                  />
                </li>
              }
            </ul>
          } @else {
            <p class="board-jobs__note" data-testid="jobs-recent-empty">
              {{ 'jobs.view.recentEmpty' | transloco }}
            </p>
          }
        }
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .board-jobs__heading {
      margin: 0;
      font-family: var(--font-display);
      font-size: var(--fs-lg);
      font-weight: var(--fw-display);
      line-height: var(--lh-tight);
    }

    .board-jobs__heading:focus {
      outline: none;
    }

    .board-jobs__availability:empty {
      display: none;
    }

    .board-jobs__line tc-icon {
      vertical-align: middle;
      margin-inline-end: var(--space-1);
    }

    .board-jobs__line a {
      color: var(--accent-text);
      white-space: nowrap;
    }

    .board-jobs__run-now {
      display: block;
      padding: var(--space-3) var(--space-4);
      border: var(--border-w) solid var(--border);
      border-radius: var(--r-lg);
      background: var(--surface);
    }

    .board-jobs__member {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      margin: 0;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--r-md);
      background: var(--bg-sunken);
      color: var(--text-2);
      font-size: var(--fs-sm);
    }

    .board-jobs__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    /*
     * #848: the quiet button's leading inset is pulled out, so its icon lines up with the title when the button wraps
     * under it; beside the title it only narrows the gap. The trailing side stays inside the runs column.
     */
    .board-jobs__refresh {
      margin-inline-start: calc(-1 * var(--space-3));
    }

    .board-jobs__title {
      margin: 0;
      font-size: var(--fs-md);
      font-weight: var(--fw-semibold);
    }

    .board-jobs__list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .board-jobs__note {
      margin: 0;
      color: var(--text-2);
      font-size: var(--fs-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardJobs {
  protected readonly store = inject(JobsStore);

  readonly slug = input.required<string>();
  protected readonly actionsSetupLink = computed(() => projectActionsRouteOf(this.slug()));
  /** The project's display name, for the owner's «no runner» copy. */
  readonly projectName = input('');
  /** Runner id → name, for the runners the caller could list (none for a member of the account). */
  readonly runnerNames = input<ReadonlyMap<string, string>>(new Map());
  /** When the runners serving the project are paused, as the owner reads them; `null` otherwise or for a member. */
  readonly pause = input<JobsPauseLine | null>(null);
  /** The runner D3 holds back from the project, from the owner's own runner list; `null` when none fits. */
  readonly d3Runner = input<RunnerDto | null>(null);
  /**
   * The caller owns the project's own account (`projectAccountRoleOf`), for the one case the jobs answer cannot say
   * it: a failed first read. Run now then stays beside the error block (#848, #775 UX spec "error"); a member's press is refused by
   * the Worker and worded by Run now itself.
   */
  readonly ownsAccount = input(false);

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly restoreRetryFocus = injectRetryFocus(() => this.heading());
  private readonly runNow = viewChild(RunNow);
  private readonly none = viewChild(BoardJobsNone);

  protected readonly isLoading = computed(() => {
    const status = this.store.status();
    return status === 'idle' || status === 'loading';
  });
  protected readonly canRun = computed(() => this.store.canRunNow());
  protected readonly showsRunNow = computed(
    () => this.canRun() || (this.store.status() === 'error' && this.ownsAccount()),
  );
  /**
   * What a job queued now waits for, said by the outcome line instead of «queued». The team's pause (#810) has no line
   * of its own here: the project's paused banner already names it, with Resume.
   */
  protected readonly waitsFor = computed((): RunNowWait | null => {
    switch (this.store.availability()) {
      case 'offline':
      case 'paused':
        return 'runner';
      case 'team-paused':
        return 'team';
      default:
        return null;
    }
  });
  protected readonly ownerPause = computed(() => (this.canRun() ? this.pause() : null));

  protected readonly noneKind = computed((): JobsNoneKind | null => {
    if (this.store.availability() !== 'none') {
      return null;
    }
    if (!this.canRun()) {
      return 'member';
    }
    // The reason reaches an owner only; without a D3 runner in the owner's own list the generic copy stays right.
    const runner = this.d3Runner();
    if (this.store.unavailableReason() === 'other-owner-subscription' && runner !== null) {
      return runner.enrolledByYou ? 'd3-mine' : 'd3';
    }
    return 'owner';
  });

  protected readonly projectLabel = computed(() => isolatedName(this.projectName() || this.slug()));
  /** The account owners a member's copy names (#775): display names only, each isolated; empty without any. */
  protected readonly ownersLabel = computed(() => this.store.ownerNames().map(isolatedName).join(', '));
  /** Who the «no runner» block names: the owners for a member, the runner's owner or the project's creator for D3. */
  protected readonly nonePeople = computed(() => {
    switch (this.noneKind()) {
      case 'member':
        return this.ownersLabel();
      case 'd3': {
        const name = this.d3Runner()?.enrolledByName ?? null;
        return name === null ? '' : isolatedName(name);
      }
      case 'd3-mine': {
        const name = this.store.projectCreatorName();
        return name === null ? '' : isolatedName(name);
      }
      default:
        return '';
    }
  });
  protected readonly d3RunnerLabel = computed(() => {
    const runner = this.d3Runner();
    return runner === null ? '' : isolatedName(runner.name);
  });

  /** The header's «Run» (#775): the kind picker, else the «no runner» heading, else this section's heading. */
  focusEntry(): void {
    const runNow = this.runNow();
    if (runNow !== undefined) {
      runNow.focus();
      return;
    }
    const none = this.none();
    if (none !== undefined) {
      none.focus();
      return;
    }
    this.heading().nativeElement.focus();
  }

  protected runnerOf(job: JobDto): string {
    return job.runnerId === null ? '' : runnerLabelOf(job.runnerId, this.runnerNames());
  }

  protected failureKey(failure: JobFailure | null): string {
    return jobFailureKeyOf(failure ?? { kind: 'error', slug: null });
  }

  protected onEnqueued(job: JobDto): void {
    this.store.add(job);
    void this.store.refresh();
  }

  protected async refresh(): Promise<void> {
    await this.store.refresh();
    this.restoreRetryFocus();
  }
}
