import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LocalDayPipe, LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Chip, Icon, Ledger, LedgerRow, StatusCard, type ChipTone, type IconName, type StatusCardTone } from '@console/shared/ui';
import type { RunnerDto } from '@shared/contracts';
import { runnerPresenceOf, type RunnerPresence } from './runner.model';

const TONES: Readonly<Record<RunnerPresence, StatusCardTone & ChipTone>> = {
  online: 'success',
  offline: 'neutral',
  'never-seen': 'neutral',
  suspect: 'warning',
  revoked: 'danger',
};

const MARKS: Readonly<Record<RunnerPresence, IconName>> = {
  online: 'check',
  offline: 'clock',
  'never-seen': 'clock',
  suspect: 'alert',
  revoked: 'x',
};

let nextCardId = 0;

/**
 * One enrolled runner on Settings › Runners (#464, ADR 0008 row 2-E): its name and presence, then backend, version
 * (flagged below the environment's minimum), when it was last seen (local time), host and the projects it may serve.
 * Text from the runner (name, hostname, os) is interpolated only. Actions are projected (`[tc-runner-actions]`).
 */
@Component({
  selector: 'tc-runner-card',
  imports: [Chip, Icon, Ledger, LedgerRow, LocalDayPipe, LocalTimePipe, StatusCard, TranslocoPipe],
  template: `
    <article tc-status-card [tone]="tone()" [attr.aria-labelledby]="titleId" data-testid="runner-card">
      <div tc-status-card-row>
        <span tc-status-card-mark aria-hidden="true"><tc-icon [name]="mark()" size="sm" /></span>
        <div tc-status-card-who>
          <h3 tc-status-card-title class="runner-card__title" [id]="titleId" dir="auto">{{ runner().name }}</h3>
          <p tc-status-card-meta class="runner-card__chips">
            <tc-chip [tone]="tone()" data-testid="runner-presence">{{
              'runners.presence.' + presenceKey() | transloco
            }}</tc-chip>
            @if (runner().belowMinimum && runner().revokedAt === null) {
              <tc-chip tone="warning" data-testid="runner-behind">{{ 'runners.card.behind' | transloco }}</tc-chip>
            }
          </p>
        </div>
      </div>
      @if (runner().suspect; as suspect) {
        <p tc-status-card-body class="runner-card__note" data-testid="runner-suspect">
          {{ 'runners.card.suspect.' + suspect.reason | transloco: { day: suspect.at | localDay, time: suspect.at | localTime } }}
        </p>
      }
      <dl tc-ledger class="runner-card__facts">
        <div tc-ledger-row [label]="'runners.card.backend' | transloco">
          {{ 'runners.backend.' + runner().isolation | transloco }}
          @if (runner().hosted) {
            · {{ 'runners.card.hosted' | transloco }}
          }
        </div>
        <div tc-ledger-row [label]="'runners.card.version' | transloco">
          <span data-testid="runner-version">{{ runner().version }}</span>
          @if (runner().belowMinimum && minimumVersion(); as minimum) {
            · {{ 'runners.card.minimum' | transloco: { version: minimum } }}
          }
          @if (runner().pinnedVersion; as pinned) {
            · {{ 'runners.card.pinned' | transloco: { version: pinned } }}
          }
        </div>
        <div tc-ledger-row [label]="'runners.card.lastSeen' | transloco">
          @if (runner().lastSeenAt; as seen) {
            <time [attr.datetime]="seen" data-testid="runner-last-seen">{{ seen | localDay }}, {{ seen | localTime }}</time>
            @if (runner().lastSeenCountry; as country) {
              · {{ country }}
            }
          } @else {
            {{ 'runners.card.neverSeen' | transloco }}
          }
        </div>
        <div tc-ledger-row [label]="'runners.card.host' | transloco">
          <span dir="auto">{{ runner().host.hostname }}</span> · {{ runner().host.os }}/{{ runner().host.arch }}
          @if (runner().capabilities.local) {
            · {{ 'runners.card.local' | transloco }}
          }
        </div>
        <div tc-ledger-row [label]="'runners.card.projects' | transloco">
          @if (runner().allowedProjects.length > 0) {
            <span data-testid="runner-projects">{{ runner().allowedProjects.join(', ') }}</span>
          } @else {
            <span data-testid="runner-projects">{{ 'runners.card.noProjects' | transloco }}</span>
          }
        </div>
        @if (runner().revokedAt; as revoked) {
          <div tc-ledger-row [label]="'runners.card.revokedAt' | transloco">
            <time [attr.datetime]="revoked">{{ revoked | localDay }}, {{ revoked | localTime }}</time>
          </div>
        }
      </dl>
      <div tc-status-card-actions class="runner-card__actions"><ng-content select="[tc-runner-actions]" /></div>
    </article>
  `,
  styles: `
    .runner-card__title {
      overflow-wrap: anywhere;
    }

    .runner-card__chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
    }

    .runner-card__note {
      margin: 0;
      color: var(--warning-text);
    }

    .runner-card__actions:empty {
      display: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunnerCard {
  readonly runner = input.required<RunnerDto>();
  /** The environment's `RUNNER_MINIMUM_VERSION`, quoted beside a runner below it. */
  readonly minimumVersion = input<string | null>(null);

  protected readonly titleId = `tc-runner-card-${nextCardId++}`;
  protected readonly presence = computed(() => runnerPresenceOf(this.runner()));
  protected readonly presenceKey = computed(() => (this.presence() === 'never-seen' ? 'neverSeen' : this.presence()));
  protected readonly tone = computed(() => TONES[this.presence()]);
  protected readonly mark = computed(() => MARKS[this.presence()]);
}
