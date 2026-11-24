import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, type TemplateRef } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { localDayOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Chip, Icon, type IconName, List, ListHeading, ListRow } from '@console/shared/ui';
import type { ArtifactType } from '@shared/contracts';
import { Artifact } from './artifact.model';
import { highlightSegments, type TitleSegment } from './highlight-segments';

/** The context of the design-row templates: the design issue artifact of that row. */
export interface DesignRowContext {
  readonly $implicit: Artifact & { readonly number: number };
}

/** One entry of the list: an artifact, or the heading that opens its type's group (#766). */
type Entry =
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly item: Artifact;
      readonly title: readonly TitleSegment[];
    }
  | { readonly kind: 'heading'; readonly key: string; readonly type: ArtifactType; readonly count: number };

const TYPE_ICONS: Readonly<Record<ArtifactType, IconName>> = { decision: 'check', design: 'pencil', demo: 'play' };

/**
 * Artifacts as rows that open their github.com page in a new tab. Titles are GitHub text and only ever interpolated;
 * the url was checked to be a github.com page before it got here.
 *
 * A design issue (#277: `number` set) is a button row instead: it emits `openDesign` for the viewer, and the page
 * fills its leading and subtitle slots through `designLeading` / `designSubtitle` templates (the thumbnail and the
 * screen count live in the design entity, which this list must not import).
 *
 * In a page body of at least `--cq-grid-min` the rows are cards (#766, `tc-list grid`); with `grouped` each type
 * opens with a heading there (the rows never show it). Headings and kickers are for the eye: a screen reader hears
 * each artifact's type from its row chip, kept out of view on a card.
 */
@Component({
  selector: 'tc-artifact-list',
  imports: [Chip, Icon, List, ListHeading, ListRow, NgTemplateOutlet, TranslocoPipe],
  template: `
    <tc-list grid [attr.aria-label]="label()">
      @for (entry of entries(); track entry.key) {
        @if (entry.kind === 'heading') {
          <tc-list-heading data-testid="artifact-group" [attr.data-type]="entry.type">
            {{ 'artifacts.type.' + entry.type | transloco }}
            <span class="artifact__count">{{ entry.count }}</span>
          </tc-list-heading>
        } @else if (entry.kind === 'item') {
          @let item = entry.item;
          @if (designOf(item); as design) {
            <tc-list-row
              button
              data-testid="artifact"
              [attr.data-type]="item.type"
              [attr.data-issue]="design.number"
              (click)="openDesign.emit(design)"
            >
              @if (designLeading(); as leading) {
                <span tc-row-leading
                  ><ng-container *ngTemplateOutlet="leading; context: { $implicit: design }"
                /></span>
              }
              <span tc-row-title dir="auto"
                ><ng-container *ngTemplateOutlet="titleRuns; context: { $implicit: entry.title }" /> <span class="tc-sr-only">{{ 'designs.row.open' | transloco }}</span></span
              >
              <span tc-row-subtitle>
                @if (designSubtitle(); as subtitle) {
                  <ng-container *ngTemplateOutlet="subtitle; context: { $implicit: design }" />
                } @else {
                  #{{ design.number }}
                }
                @if (item.updatedAt) {
                  · {{ dayOf(item.updatedAt) }}
                }
              </span>
              @if (item.awaitingApproval) {
                <span tc-row-detail class="artifact__awaiting" data-testid="artifact-awaiting">{{
                  'designs.row.awaiting' | transloco
                }}</span>
              }
              <tc-chip tc-row-trailing>{{ 'artifacts.type.' + item.type | transloco }}</tc-chip>
            </tc-list-row>
          } @else {
            <tc-list-row [href]="item.url" external data-testid="artifact" [attr.data-type]="item.type">
              <span tc-row-kicker aria-hidden="true">
                <tc-icon class="artifact__type-icon" [name]="typeIcon(item.type)" size="sm" />
                {{ 'artifacts.typeOne.' + item.type | transloco }}
                <tc-icon class="artifact__external" name="external" size="sm" />
              </span>
              <span tc-row-title dir="auto"
                ><ng-container *ngTemplateOutlet="titleRuns; context: { $implicit: entry.title }" />
                <span class="tc-sr-only">{{ 'artifacts.opensGitHub' | transloco }}</span></span
              >
              <span tc-row-subtitle>
                {{ 'artifacts.source.' + item.source | transloco }}
                @if (item.state) {
                  · {{ 'artifacts.state.' + item.state | transloco }}
                }
                @if (item.updatedAt) {
                  · {{ dayOf(item.updatedAt) }}
                }
              </span>
              <tc-chip tc-row-trailing>{{ 'artifacts.type.' + item.type | transloco }}</tc-chip>
            </tc-list-row>
          }
        }
      }
    </tc-list>
    <ng-template #titleRuns let-runs>
      @for (run of runs; track $index) { @if (run.isMatch) {<mark class="artifact__mark" data-testid="artifact-mark">{{ run.text }}</mark>} @else {{{ run.text }}} }
    </ng-template>
  `,
  styles: `
    :host {
      --tc-list-card-min: var(--artifact-card-min);
      --tc-list-cols-max: var(--artifact-cols-max);
    }

    /*
     * A search hit (#362): a marker bar behind the word, drawn left to right. The bar is the mark's own background,
     * revealed by a clip from the left (a gradient would hide it from the contrast check); under reduced motion --dur-base collapses and it is there at once.
     */
    .artifact__mark {
      border-radius: var(--r-sm);
      background: var(--accent-soft);
      color: inherit;
      animation: artifact-mark-draw var(--dur-base) var(--ease-standard) both;
    }

    @keyframes artifact-mark-draw {
      from {
        clip-path: inset(0 100% 0 0);
      }
    }

    .artifact__awaiting {
      color: var(--warning-text);
      font-size: var(--fs-xs);
      font-weight: var(--fw-semibold);
    }

    .artifact__count {
      font-family: var(--font-mono);
      font-weight: var(--fw-regular);
      color: var(--text-3);
    }

    [tc-row-kicker] {
      display: flex;
      flex: 1;
      align-items: center;
      gap: var(--space-1);
    }

    .artifact__type-icon {
      color: var(--accent-text);
    }

    .artifact__external {
      margin-left: auto;
      color: var(--text-3);
    }

    /* --cq-grid-min: on a card the waiting line is a pill under the summary (#766). */
    @container (min-width: 880px) {
      .artifact__awaiting {
        justify-self: start;
        margin-top: var(--space-1);
        padding: calc(2 * var(--space-px)) var(--space-2);
        border-radius: var(--r-pill);
        background: var(--warning-soft);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtifactList {
  private readonly transloco = inject(TranslocoService);

  readonly items = input.required<readonly Artifact[]>();
  /** The list's accessible name. */
  readonly label = input.required<string>();
  /** Rendered in a design row's leading slot (the thumbnail). */
  readonly designLeading = input<TemplateRef<DesignRowContext> | null>(null);
  /** Rendered as a design row's subtitle (number, screens, devices); the number alone without it. */
  readonly designSubtitle = input<TemplateRef<DesignRowContext> | null>(null);

  /** The search's words: every hit in a title is marked (#362). Empty shows titles plain. */
  readonly highlight = input<readonly string[]>([]);

  /** Each type opens with a heading on the cards (#766): set it while every type shows. */
  readonly grouped = input(false);

  /** A design issue row was pressed: open it in the viewer. */
  readonly openDesign = output<Artifact & { readonly number: number }>();

  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly entries = computed<readonly Entry[]>(() => {
    const items = this.items();
    const terms = this.highlight();
    const counts = new Map<ArtifactType, number>();
    for (const item of items) {
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    }
    const entries: Entry[] = [];
    let previous: ArtifactType | null = null;
    for (const item of items) {
      if (this.grouped() && item.type !== previous) {
        entries.push({
          kind: 'heading',
          key: `# ${item.type} ${item.url}`,
          type: item.type,
          count: counts.get(item.type) ?? 0,
        });
      }
      previous = item.type;
      entries.push({
        kind: 'item',
        key: `${item.type} ${item.url}`,
        item,
        title: highlightSegments(item.title, terms),
      });
    }
    return entries;
  });

  protected typeIcon(type: ArtifactType): IconName {
    return TYPE_ICONS[type];
  }

  protected dayOf(iso: string): string {
    return localDayOf(iso, this.lang());
  }

  /** The row as a design issue when it is one (a design artifact with an issue number). */
  protected designOf(item: Artifact): (Artifact & { readonly number: number }) | null {
    return item.type === 'design' && item.source === 'issue' && typeof item.number === 'number'
      ? { ...item, number: item.number }
      : null;
  }
}
