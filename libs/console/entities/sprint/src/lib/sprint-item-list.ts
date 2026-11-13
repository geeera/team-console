import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, type TemplateRef } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, List, ListRow, Tooltip } from '@console/shared/ui';
import { isItemKind, type ItemKind, type SprintCiState, type SprintTier } from '@shared/contracts';
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
 * github.com link opens it in a new tab; a console-tracker task (no link) opens its task screen when `slug` is set
 * (#557). The kind word leads the subtitle. `rowAction` renders beside each issue row, outside its link (#558).
 */
@Component({
  selector: 'tc-sprint-item-list',
  imports: [Chip, List, ListRow, NgTemplateOutlet, SprintCiChip, SprintTierIcon, Tooltip, TranslocoPipe],
  template: `
    <tc-list>
      @for (item of items(); track item.number) {
        <tc-list-row
          [href]="item.url ?? ''"
          external
          [link]="consoleLinkOf(item)"
          [attr.data-number]="item.number"
        >
          <span tc-row-leading class="sprint-item__number">#{{ item.number }}</span>
          <span tc-row-title dir="auto"
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
                <tc-chip tone="warning" dot data-testid="untrusted">{{
                  'board.untrusted' | transloco
                }}</tc-chip>
              }
            </span>
          } @else if (kindOf(item) || !item.authorTrusted || isPending(item)) {
            <span tc-row-subtitle class="sprint-item__marks">
              @if (kindOf(item); as kind) {
                <span class="sprint-item__kind" data-testid="kind">{{ 'board.kind.' + kind | transloco }}</span>
              }
              @if (isPending(item)) {
                <!-- #219: the owner asked the PM about this issue; the PM has not answered yet. -->
                <tc-chip tone="warning" dot data-testid="request-pending">{{
                  'board.pending' | transloco
                }}</tc-chip>
              }
              @if (!item.authorTrusted) {
                <tc-chip tone="warning" dot data-testid="untrusted">{{
                  'board.untrusted' | transloco
                }}</tc-chip>
              }
            </span>
          }
          @if (tierOf(item); as tier) {
            <!-- The icon is not a control (the row already is a link): its name is hidden text in the link, and the
                 tooltip repeats it for the mouse and keyboard, beside the icon because the list clips above it. -->
            <tc-sprint-tier-icon tc-row-trailing [tier]="tier" data-testid="tier">
              <span class="tc-sr-only"
                >{{ 'board.tierLabel' | transloco }} {{ 'board.tier.' + tier | transloco }}</span
              >
              <tc-tooltip placement="start"
                >{{ 'board.tierLabel' | transloco }} {{ 'board.tier.' + tier | transloco }}</tc-tooltip
              >
            </tc-sprint-tier-icon>
          } @else if (isDraft(item)) {
            <tc-chip tc-row-trailing data-testid="draft">{{ 'board.draft' | transloco }}</tc-chip>
          }
          <!-- One @if with the slot as its only root, so the span is projected beside the link, not inside it. -->
          @if (rowAction() && issueOf(item)) {
            <span tc-row-action
              ><ng-container *ngTemplateOutlet="rowAction(); context: { $implicit: item }"
            /></span>
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
  /** The project of console-tracker rows: a row without a GitHub link opens `/p/:slug/t/:n`. */
  readonly slug = input<string | null>(null);
  /** A control per issue row (the Move menu, #558); declared here so the list owns where it sits. */
  readonly rowAction = input<TemplateRef<{ $implicit: SprintIssue }> | null>(null);

  protected consoleLinkOf(item: SprintListItem): string[] | null {
    const slug = this.slug();
    // The task route as `itemRouteOf` (@console/entities/item) builds it; an entity cannot import another.
    return slug !== null && item.url === null && isIssue(item) ? ['/p', slug, 't', String(item.number)] : null;
  }

  protected issueOf(item: SprintListItem): SprintIssue | null {
    return isIssue(item) ? item : null;
  }

  /** Only the kinds the catalogue names; an issue without a known `kind:*` label shows none. */
  protected kindOf(item: SprintListItem): ItemKind | null {
    return isIssue(item) && isItemKind(item.kind) ? item.kind : null;
  }

  protected tierOf(item: SprintListItem): SprintTier | null {
    return isIssue(item) ? item.tier : null;
  }

  protected ciOf(item: SprintListItem): SprintCiState | null {
    return isIssue(item) ? null : item.ci;
  }

  protected isPending(item: SprintListItem): boolean {
    return isIssue(item) && item.request?.state === 'pending';
  }

  protected isDraft(item: SprintListItem): boolean {
    return !isIssue(item) && item.draft;
  }
}
