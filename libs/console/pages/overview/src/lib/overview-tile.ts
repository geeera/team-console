import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { spaceUrlOf, type OverviewProject } from '@console/entities/project';
import { demoDayOf } from '@console/entities/sprint';
import { snoozeWhenOf } from '@console/features/snooze';
import {
  localDayOf,
  LocalNumberPipe,
  TranslocoPipe,
  TranslocoPluralPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Chip, ChipTone, Icon, Meter } from '@console/shared/ui';
import { isSnoozeActive, NOT_SNOOZED, type OverviewTeamState, type SnoozeDto } from '@shared/contracts';

const TEAM_TONE: Readonly<Record<OverviewTeamState, ChipTone>> = {
  running: 'success',
  paused: 'neutral',
  failing: 'danger',
  unknown: 'warning',
};

/** Not read in this request: the Worker's subrequest budget ran out first; the next request continues. */
export const OVERVIEW_PENDING_PROBLEM = 'github-request-budget';

const KNOWN_PROBLEMS: ReadonlySet<string> = new Set([
  'github-app-not-installed',
  'project-config-invalid',
  'github-rate-limit',
  'project-invalid',
]);

/**
 * One project on the overview (#27, Paper Desk direction): name and team state, the sprint and its demo day, done /
 * total with a meter, what waits for the owner and whether setup is unfinished. The whole tile is the link to the
 * project's board; a project that could not be read says why in its own tile and still links there. A project whose
 * notifications are snoozed says so under the rest with the struck bell (#222). Controls projected as
 * `[tc-tile-actions]` sit inside the card, below the link (a link holds no button).
 * The project name and the sprint title are interpolated only, never bound as HTML.
 */
@Component({
  selector: 'tc-overview-tile',
  imports: [Chip, Icon, LocalNumberPipe, Meter, RouterLink, TranslocoPipe, TranslocoPluralPipe],
  template: `
    @let row = project();
    <a class="ov" [routerLink]="boardUrl()" data-testid="overview-row" [attr.data-project]="row.slug">
      <span class="ov__top">
        <span class="ov__name">{{ row.name }}</span>
        @if (row.kind === 'read') {
          <tc-chip dot [tone]="teamTone()" data-testid="team" [attr.data-team]="row.team">{{
            'overview.team.' + row.team | transloco
          }}</tc-chip>
        }
      </span>
      @if (row.kind === 'read') {
        <span class="ov__line" data-testid="sprint">
          @if (row.sprint; as sprint) {
            {{ sprint.title }} · {{ 'overview.demo' | transloco: { date: demoDate() } }}
          } @else {
            {{ 'overview.noSprint' | transloco }}
          }
        </span>
        @if (row.sprint; as sprint) {
          <tc-meter class="ov__meter" [value]="sprint.shipped" [max]="sprint.planned" />
        }
        <span class="ov__foot">
          <span class="ov__progress" data-testid="progress">
            @if (row.sprint; as sprint) {
              {{
                'overview.done'
                  | transloco: { done: (sprint.shipped | localNumber), total: (sprint.planned | localNumber) }
              }}
            }
          </span>
          @if (row.setup) {
            <tc-chip tone="warning" data-testid="setup">{{ 'overview.setup' | transloco }}</tc-chip>
          }
          @if (waiting() > 0) {
            <!-- A number with its words (#275 §7.10): a bare «9» said nothing. -->
            <tc-chip tone="accent" data-testid="needs-you">{{
              'overview.waiting' | translocoPlural: waiting()
            }}</tc-chip>
          }
        </span>
      } @else if (row.problem === pendingProblem) {
        <span
          class="ov__problem ov__problem--pending"
          data-testid="problem"
          [attr.data-problem]="row.problem"
        >
          <tc-icon name="clock" size="sm" />
          {{ 'overview.pending' | transloco }}
        </span>
      } @else {
        <span class="ov__problem" data-testid="problem" [attr.data-problem]="row.problem">
          <tc-icon name="alert" size="sm" />
          {{ 'overview.problem.lead' | transloco: { reason: problemReason() } }}
        </span>
      }
      @if (snoozeLine(); as line) {
        <span class="ov__snoozed" data-testid="snoozed">
          <tc-icon name="bell-off" size="sm" />
          {{ line }}
        </span>
      }
    </a>
    <ng-content select="[tc-tile-actions]" />
  `,
  styleUrl: './overview-tile.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewTile {
  private readonly transloco = inject(TranslocoService);

  protected readonly pendingProblem = OVERVIEW_PENDING_PROBLEM;

  readonly project = input.required<OverviewProject>();
  /** Items waiting for the owner, less the ones answered from this device while GitHub still lists them. */
  readonly waiting = input(0);
  /** The project's snooze (#221); shown while it mutes at `now`. */
  readonly snooze = input<SnoozeDto>(NOT_SNOOZED);
  /** The page's clock, so a snooze that ends while the page is open loses its line. */
  readonly now = input(Date.now());

  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly boardUrl = computed(() => spaceUrlOf(this.project().slug, 'board'));

  protected readonly teamTone = computed<ChipTone>(() => {
    const row = this.project();
    return row.kind === 'read' ? TEAM_TONE[row.team] : 'neutral';
  });

  protected readonly demoDate = computed(() => {
    const lang = this.lang();
    const row = this.project();
    return row.kind === 'read' && row.sprint !== null ? localDayOf(demoDayOf(row.sprint.dueOn), lang) : '';
  });

  protected readonly snoozeLine = computed<string | null>(() => {
    const snooze = this.snooze();
    const nowMs = this.now();
    const lang = this.lang();
    if (!snooze.snoozed || !isSnoozeActive(snooze, nowMs)) {
      return null;
    }
    if (snooze.until === null) {
      return this.transloco.translate('overview.snoozed');
    }
    const when = snoozeWhenOf(snooze.until, lang, nowMs);
    return this.transloco.translate('overview.snoozedUntil', {
      until: this.transloco.translate(when.key, when.params),
    });
  });

  protected readonly problemReason = computed(() => {
    this.lang();
    const row = this.project();
    const problem = row.kind === 'failed' && KNOWN_PROBLEMS.has(row.problem) ? row.problem : 'other';
    return this.transloco.translate(`overview.problem.${problem}`);
  });
}
