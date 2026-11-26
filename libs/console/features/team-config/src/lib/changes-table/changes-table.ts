import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';

/** One row of the table, already worded. */
export interface ChangeRow {
  readonly path: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  /** A consequence of this change the owner should read before saving ("ends the waiver for November"). */
  readonly note?: string;
}

/**
 * Setting · Was · Now (#688, UX spec §6 "Diff view"): a real table with `th` scopes, every value in words, the old
 * one struck through as well as labelled by its column — never colour or the line alone. Used by the review before
 * a save and by "Show their changes" after a conflict. Values are interpolated text, never HTML (threat model T4).
 */
@Component({
  selector: 'tc-changes-table',
  imports: [TranslocoPipe],
  template: `
    <table class="changes" data-testid="changes-table">
      @if (caption(); as caption) {
        <caption class="tc-sr-only">
          {{
            caption
          }}
        </caption>
      }
      <thead>
        <tr>
          <th scope="col">{{ 'teamConfig.review.field' | transloco }}</th>
          <th scope="col">{{ 'teamConfig.review.old' | transloco }}</th>
          <th scope="col">{{ 'teamConfig.review.new' | transloco }}</th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.path) {
          <tr [attr.data-path]="row.path">
            <th scope="row">{{ row.label }}</th>
            <td>
              <s class="changes__old">{{ row.from }}</s>
            </td>
            <td class="changes__new">
              {{ row.to }}
              @if (row.note; as note) {
                <span class="changes__note" [attr.data-testid]="'change-note-' + row.path">{{ note }}</span>
              }
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styleUrl: './changes-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangesTable {
  readonly rows = input.required<readonly ChangeRow[]>();
  /** A name for screen readers when the heading around the table does not give one. */
  readonly caption = input<string | null>(null);
}
