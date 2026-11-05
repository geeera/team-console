import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Icon, Spinner } from '@console/shared/ui';

export type TaskLoadState = 'loading' | 'not-found' | 'error' | 'offline' | 'forbidden';

/**
 * The task screen before it has a task (#409 §3): the skeleton (`aria-busy`, static), "There's no task TC-999 in
 * team-console" with Board, the load error and the never-loaded offline block with Try again, the owner-only note.
 * Each has its own h1 (`tabindex="-1"`), so the screen's focus-on-open lands on it.
 */
@Component({
  selector: 'tc-task-state',
  imports: [Button, Icon, RouterLink, Spinner, TranslocoPipe],
  templateUrl: './task-state.html',
  styleUrl: './task-state.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskState {
  readonly state = input.required<TaskLoadState>();
  readonly key = input.required<string>();
  readonly slug = input.required<string>();
  readonly projectName = input.required<string>();
  readonly retry = output<void>();
}
