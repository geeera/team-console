import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Icon, Meter } from '@console/shared/ui';
import type { TeamStatusDto } from '@shared/contracts';

/** The sprint on the status card (#218), in words. */
export interface SprintFacts {
  /** "Sprint 04 · demo 14 October"; or why there is none. */
  readonly line: string;
  /** "freeze 12–14 October", or "freeze now, until the demo" (ochre); empty without a sprint. */
  readonly freeze: string;
  readonly isFreezeNow: boolean;
}

/**
 * The panel's status card (#114, #218): the team's state as a sentence (the dot only repeats it), the sprint and its
 * progress, when it was read, Refresh and the run log. The panel decides every word; this draws them. Its own
 * component so its styles are its own (#123: the panel's stylesheet stays under the per-component budget).
 */
@Component({
  selector: 'tc-commands-status',
  imports: [Icon, LocalTimePipe, Meter, TranslocoPipe],
  templateUrl: './commands-status.html',
  styleUrl: './commands-status.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandsStatus {
  readonly status = input.required<TeamStatusDto>();
  readonly stateText = input.required<string>();
  readonly sprintFacts = input.required<SprintFacts>();
  readonly paused = input.required<boolean>();
  /** A read is running or the device is offline: Refresh says so and does nothing. */
  readonly refreshOff = input.required<boolean>();
  readonly refreshing = input.required<boolean>();
  /** Refresh was pressed. */
  readonly refresh = output<void>();
}
