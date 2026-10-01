import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, ChipTone, List, ListRow } from '@console/shared/ui';
import type { SprintTier } from '@shared/contracts';
import { SprintIssue, SprintPullRequest } from './sprint.model';

export type SprintListItem = SprintIssue | SprintPullRequest;

const TIER_TONES: Readonly<Record<SprintTier, ChipTone>> = {
  light: 'neutral',
  standard: 'accent',
  heavy: 'warning',
};

function isIssue(item: SprintListItem): item is SprintIssue {
  return 'tier' in item;
}

/**
 * Sprint issues (with their tier) or pull requests (with a draft mark) as rows. Titles are untrusted GitHub text and
 * only ever interpolated; an item from outside the team carries the same mark as a question card (#16). A row with a
 * github.com link opens it in a new tab — the board itself never changes anything.
 */
@Component({
  selector: 'tc-sprint-item-list',
  imports: [Chip, List, ListRow, TranslocoPipe],
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
          @if (!item.authorTrusted) {
            <span tc-row-subtitle data-testid="untrusted">
              <tc-chip tone="warning" dot>{{ 'board.untrusted' | transloco }}</tc-chip>
            </span>
          }
          @if (tierOf(item); as tier) {
            <tc-chip tc-row-trailing [tone]="tierTone(tier)" data-testid="tier">
              <span class="tc-sr-only">{{ 'board.tierLabel' | transloco }}</span>
              {{ 'board.tier.' + tier | transloco }}
            </tc-chip>
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

  protected tierTone(tier: SprintTier): ChipTone {
    return TIER_TONES[tier];
  }

  protected isDraft(item: SprintListItem): boolean {
    return !isIssue(item) && item.draft;
  }
}
