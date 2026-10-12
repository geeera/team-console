import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import {
  Button,
  Chip,
  DIALOG_DATA,
  DialogRef,
  Field,
  FieldControl,
  List,
  ListRow,
  SheetFooter,
  StateBlock,
} from '@console/shared/ui';
import type { RequestIssueDto } from '@shared/contracts';

export interface RequestPickerData {
  /** The open issues, or `null` when they could not be read. */
  readonly load: () => Promise<readonly RequestIssueDto[] | null>;
}

/** `#12`, `12` or words of the title; case-insensitive. */
export function matchesQuery(issue: RequestIssueDto, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  const number = q.startsWith('#') ? q.slice(1) : q;
  return String(issue.number).startsWith(number) || issue.title.toLowerCase().includes(q);
}

/**
 * "Which issue is it about?" (#219, design #29): a search field and the open issues, each with its request state;
 * closes with the picked number. Titles are GitHub text, interpolated only.
 */
@Component({
  selector: 'tc-request-picker-dialog',
  imports: [Button, Chip, Field, FieldControl, List, ListRow, SheetFooter, StateBlock, TranslocoPipe],
  template: `
    <div class="picker">
      <tc-field [label]="'commands.pick.find' | transloco">
        <input
          tcInput
          type="search"
          autocomplete="off"
          data-testid="pick-search"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </tc-field>
      @switch (phase()) {
        @case ('loading') {
          <tc-state-block kind="loading" compact [title]="'commands.pick.loading' | transloco" />
        }
        @case ('error') {
          <tc-state-block kind="error" compact [title]="'commands.pick.error' | transloco">
            <button tc-button tc-state-action type="button" (click)="reload()">
              {{ 'commands.dialog.retry' | transloco }}
            </button>
          </tc-state-block>
        }
        @default {
          @if (issues().length === 0) {
            <tc-state-block kind="empty" compact [title]="'commands.pick.empty' | transloco" />
          } @else if (shown().length === 0) {
            <tc-state-block kind="empty" compact [title]="'commands.pick.none' | transloco: { q: query() }" />
          } @else {
            <tc-list class="picker__list" data-testid="pick-list">
              @for (issue of shown(); track issue.number) {
                <tc-list-row button [attr.data-number]="issue.number" (click)="pick(issue.number)">
                  <span tc-row-leading class="picker__number">#{{ issue.number }}</span>
                  <span tc-row-title dir="auto">{{ issue.title }}</span>
                  @if (issue.request; as request) {
                    <span tc-row-subtitle>
                      <tc-chip [tone]="request.state === 'pending' ? 'warning' : 'neutral'" dot>{{
                        'commands.pick.' + request.state | transloco
                      }}</tc-chip>
                    </span>
                  }
                </tc-list-row>
              }
            </tc-list>
          }
        }
      }
    </div>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close()">
        {{ 'commands.dialog.cancel' | transloco }}
      </button>
    </ng-template>
  `,
  styleUrl: './request-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestPickerDialog {
  private readonly data = inject<RequestPickerData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<number>>(DialogRef);

  protected readonly query = signal('');
  protected readonly phase = signal<'loading' | 'error' | 'ready'>('loading');
  protected readonly issues = signal<readonly RequestIssueDto[]>([]);
  protected readonly shown = computed(() =>
    this.issues().filter((issue) => matchesQuery(issue, this.query())),
  );

  constructor() {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.phase.set('loading');
    const issues = await this.data.load();
    if (issues === null) {
      this.phase.set('error');
      return;
    }
    this.issues.set(issues);
    this.phase.set('ready');
  }

  protected pick(number: number): void {
    this.ref.close(number);
  }
}
