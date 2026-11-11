import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LocalDayPipe, LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import {
  Chip,
  Icon,
  Ledger,
  LedgerRow,
  StatusCard,
  type ChipTone,
  type StatusCardTone,
} from '@console/shared/ui';
import type { JobDto, JobEventDto, JobEventLevel, JobState } from '@shared/contracts';
import { JOB_STATE_ICONS, jobEventTextOf, jobSummaryOf } from './job.model';

const TONES: Readonly<Record<JobState, StatusCardTone & ChipTone>> = {
  queued: 'neutral',
  claimed: 'warning',
  running: 'warning',
  finished: 'success',
  failed: 'danger',
  lost: 'danger',
  cancelled: 'neutral',
};

const LEVEL_TONES: Readonly<Record<JobEventLevel, ChipTone>> = {
  info: 'neutral',
  warn: 'warning',
  error: 'danger',
};

/** The tail of the log a card shows; the store keeps a little more. */
export const JOB_CARD_EVENTS_SHOWN = 20;

let nextCardId = 0;

/**
 * One job of the project's queue (#464, ADR 0008 row 2-E): its kind and state, the runner that holds it (named by the
 * caller, who knows the account's runners), when it was queued, started and ended, an ended job's summary and the
 * tail of its events. Runner text (event lines, the summary) is plain text, interpolated only, never markup.
 */
@Component({
  selector: 'tc-job-card',
  imports: [Chip, Icon, Ledger, LedgerRow, LocalDayPipe, LocalTimePipe, StatusCard, TranslocoPipe],
  template: `
    <article
      tc-status-card
      [tone]="tone()"
      [attr.aria-labelledby]="titleId"
      data-testid="job-card"
      [attr.data-state]="job().state"
      [attr.data-kind]="job().kind"
    >
      <div tc-status-card-row>
        <span tc-status-card-mark aria-hidden="true"><tc-icon [name]="mark()" size="sm" /></span>
        <div tc-status-card-who>
          <h3 tc-status-card-title [id]="titleId">{{ 'jobs.kind.' + job().kind | transloco }}</h3>
          <p tc-status-card-meta>
            <tc-chip [tone]="tone()" data-testid="job-state">{{
              'jobs.state.' + job().state | transloco
            }}</tc-chip>
          </p>
        </div>
      </div>
      <dl tc-ledger class="job-card__facts">
        <div tc-ledger-row [label]="'jobs.card.runner' | transloco">
          @if (job().runnerId !== null) {
            <span data-testid="job-runner" dir="auto">{{ runnerName() }}</span>
          } @else if (job().state === 'queued') {
            <span data-testid="job-runner">{{ 'jobs.card.waitingForRunner' | transloco }}</span>
          } @else {
            <span data-testid="job-runner">{{ 'jobs.card.noRunner' | transloco }}</span>
          }
        </div>
        <div tc-ledger-row [label]="'jobs.card.queuedAt' | transloco">
          <time [attr.datetime]="job().createdAt"
            >{{ job().createdAt | localDay }}, {{ job().createdAt | localTime }}</time
          >
        </div>
        @if (job().startedAt; as started) {
          <div tc-ledger-row [label]="'jobs.card.startedAt' | transloco">
            <time [attr.datetime]="started">{{ started | localDay }}, {{ started | localTime }}</time>
          </div>
        }
        @if (job().finishedAt; as finished) {
          <div tc-ledger-row [label]="'jobs.card.finishedAt' | transloco">
            <time [attr.datetime]="finished">{{ finished | localDay }}, {{ finished | localTime }}</time>
          </div>
        }
        @if (job().attempt > 1) {
          <div tc-ledger-row [label]="'jobs.card.attempt' | transloco">{{ job().attempt }}</div>
        }
        @if (summary(); as text) {
          <div tc-ledger-row [label]="'jobs.card.summary' | transloco">
            <span data-testid="job-summary" dir="auto">{{ text }}</span>
          </div>
        }
      </dl>
      @if (shownEvents().length > 0) {
        <ol
          class="job-card__events"
          data-testid="job-events"
          [attr.aria-label]="'jobs.card.events' | transloco"
        >
          @for (event of shownEvents(); track event.seq) {
            <li class="job-card__event" data-testid="job-event" [attr.data-kind]="event.kind">
              <time class="job-card__event-at" [attr.datetime]="event.at">{{ event.at | localTime }}</time>
              <span class="job-card__event-kind">{{ 'jobs.event.' + event.kind | transloco }}</span>
              @if (event.level !== 'info') {
                <tc-chip [tone]="levelTone(event.level)">{{
                  'jobs.level.' + event.level | transloco
                }}</tc-chip>
              }
              @if (textOf(event); as text) {
                <span class="job-card__event-text" dir="auto">{{ text }}</span>
              }
            </li>
          }
        </ol>
      } @else if (isHeld()) {
        <p tc-status-card-body class="job-card__note" data-testid="job-events-none">
          {{ 'jobs.card.noEvents' | transloco }}
        </p>
      }
      @if (eventsFailed()) {
        <p tc-status-card-body class="job-card__note" role="status" data-testid="job-events-failed">
          {{ 'jobs.card.eventsFailed' | transloco }}
        </p>
      }
    </article>
  `,
  styles: `
    .job-card__events {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: var(--fs-sm);
    }

    .job-card__event {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
    }

    .job-card__event-at,
    .job-card__note {
      color: var(--text-2);
    }

    .job-card__event-text {
      flex-basis: 100%;
      overflow-wrap: anywhere;
    }

    .job-card__note {
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobCard {
  readonly job = input.required<JobDto>();
  /** The holding runner's name as the caller knows it; the card shows nothing about runners it was not given. */
  readonly runnerName = input<string>('');
  readonly events = input<readonly JobEventDto[]>([]);
  /** The last events read failed: the log shown may be behind. */
  readonly eventsFailed = input(false);

  protected readonly titleId = `tc-job-card-${nextCardId++}`;
  protected readonly tone = computed(() => TONES[this.job().state]);
  protected readonly mark = computed(() => JOB_STATE_ICONS[this.job().state]);
  protected readonly isHeld = computed(
    () => this.job().state === 'claimed' || this.job().state === 'running',
  );
  protected readonly summary = computed(() => jobSummaryOf(this.job()));
  protected readonly shownEvents = computed(() => this.events().slice(-JOB_CARD_EVENTS_SHOWN));

  protected textOf(event: JobEventDto): string | null {
    return jobEventTextOf(event);
  }

  protected levelTone(level: JobEventLevel): ChipTone {
    return LEVEL_TONES[level];
  }
}
