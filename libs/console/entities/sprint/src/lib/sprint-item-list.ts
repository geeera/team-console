import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, List, ListRow, Tooltip } from '@console/shared/ui';
import type { SprintCiState, SprintTier } from '@shared/contracts';
import { SprintIssue, SprintPullRequest } from './sprint.model';
import { SprintCiChip } from './sprint-ci';
import { SprintTierIcon } from './sprint-tier-icon';

export type SprintListItem = SprintIssue | SprintPullRequest;

function isIssue(item: SprintListItem): item is SprintIssue {
  return 'tier' in item;
}

/**
 * Sprint issues (with their tier icon) or pull requests (with their CI state and a draft mark) as rows. Titles are untrusted GitHub text and
 * only ever interpolated; an item from outside the team carries the same mark as a question card (#16). A row with a
 * github.com link opens it in a new tab — the board itself never changes anything.
 */
@Component({
  selector: 'tc-sprint-item-list',
  imports: [Chip, List, ListRow, SprintCiChip, SprintTierIcon, Tooltip, TranslocoPipe],
  template: `
    <tc-list>
      @for (item of items(); track item.number) {
        <tc-list-row [href]="item.url ?? ''" external [attr.data-number]="item.number">
          <span tc-row-leading class="sprint-item__number">#{{ item.number }}</span>
          <span tc-row-title
            >{{ item.title }}
            @if (item.url) {
              <span class="tc-sr-only">{{ 'board.opensGitHub' | transloco }}</span>
            }
          </span>
          @if (ciOf(item); as ci) {
            <!-- Under the title, not trailing: on the phone a second trailing chip would squeeze the title. -->
            <span tc-row-subtitle class="sprint-item__marks">
              <tc-sprint-ci-chip [state]="ci" data-testid="ci" />
              @if (!item.authorTrusted) {
                <tc-chip tone="warning" dot data-testid="untrusted">{{ 'board.untrusted' | transloco }}</tc-chip>
              }
            </span>
          } @else if (!item.authorTrusted) {
            <span tc-row-subtitle data-testid="untrusted">
              <tc-chip tone="warning" dot>{{ 'board.untrusted' | transloco }}</tc-chip>
            </span>
          }
          @if (tierOf(item); as tier) {
            <!-- The icon is not a control (the row already is a link): its name is hidden text in the link, and the
                 tooltip repeats it for the mouse and keyboard, beside the icon because the list clips above it. -->
            <tc-sprint-tier-icon tc-row-trailing [tier]="tier" data-testid="tier">
              <span class="tc-sr-only">{{ 'board.tierLabel' | transloco }} {{ 'board.tier.' + tier | transloco }}</span>
              <tc-tooltip placement="start"
                >{{ 'board.tierLabel' | transloco }} {{ 'board.tier.' + tier | transloco }}</tc-tooltip
              >
            </tc-sprint-tier-icon>
          } @else if (isDraft(item)) {
            <tc-chip tc-row-trailing data-testid="draft">{{ 'board.draft' | transloco }}</tc-chip>
          }
        </tc-list-row>
      }
    </tc-list>
  `,
  styleUrl: './sprint-item-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SprintItemList {
  readonly items = input.required<readonly SprintListItem[]>();

  protected tierOf(item: SprintListItem): SprintTier | null {
    return isIssue(item) ? item.tier : null;
  }

  protected ciOf(item: SprintListItem): SprintCiState | null {
    return isIssue(item) ? null : item.ci;
  }

  protected isDraft(item: SprintListItem): boolean {
    return !isIssue(item) && item.draft;
  }
}
