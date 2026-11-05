import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { HistoryEntry } from '@console/entities/item';
import { LocalDayPipe, LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Button } from '@console/shared/ui';
import type { TaskNames } from './task-names';

/** History shows the newest this many entries; "Show earlier: N" opens the rest. */
export const HISTORY_SHOWN = 20;

/** A task's History (#409 §3, §5): an `ol`, oldest first, each entry's author and time first. */
@Component({
  selector: 'tc-task-history',
  imports: [Button, LocalDayPipe, LocalTimePipe, TranslocoPipe],
  template: `
    @if (earlierCount() > 0) {
      <button
        tc-button
        variant="quiet"
        size="sm"
        type="button"
        class="tc-task-history__earlier"
        (click)="isFull.set(true)"
      >
        {{ 'item.earlier' | transloco: { n: earlierCount() } }}
      </button>
    }
    <ol class="tc-task-history__list" data-testid="task-history">
      @for (entry of shown(); track entry.id) {
        <li [class.tc-task-history__entry--owner]="entry.isOwner" [attr.data-kind]="entry.line.kind">
          <span class="tc-task-history__who">
            <b>{{ names().who(entry.actor) }}</b>
            <span>{{ entry.at | localDay }}, {{ entry.at | localTime }}</span>
          </span>
          @if (entry.line.kind === 'comment') {
            <p class="tc-task-history__text" dir="auto">{{ entry.line.text }}</p>
          } @else {
            <p class="tc-task-history__what">{{ names().line(entry) }}</p>
          }
        </li>
      }
    </ol>
  `,
  styleUrl: './task-history.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-task-history' },
})
export class TaskHistory {
  readonly history = input.required<readonly HistoryEntry[]>();
  readonly names = input.required<TaskNames>();

  protected readonly isFull = signal(false);
  protected readonly shown = computed(() => {
    const all = this.history();
    return this.isFull() ? all : all.slice(Math.max(0, all.length - HISTORY_SHOWN));
  });
  protected readonly earlierCount = computed(() => this.history().length - this.shown().length);
}
