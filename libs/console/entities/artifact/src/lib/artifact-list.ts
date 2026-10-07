import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, type TemplateRef } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { localDayOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Chip, List, ListRow } from '@console/shared/ui';
import { Artifact } from './artifact.model';

/** The context of the design-row templates: the design issue artifact of that row. */
export interface DesignRowContext {
  readonly $implicit: Artifact & { readonly number: number };
}

/**
 * Artifacts as rows that open their github.com page in a new tab. Titles are GitHub text and only ever interpolated;
 * the url was checked to be a github.com page before it got here.
 *
 * A design issue (#277: `number` set) is a button row instead: it emits `openDesign` for the viewer, and the page
 * fills its leading and subtitle slots through `designLeading` / `designSubtitle` templates (the thumbnail and the
 * screen count live in the design entity, which this list must not import).
 */
@Component({
  selector: 'tc-artifact-list',
  imports: [Chip, List, ListRow, NgTemplateOutlet, TranslocoPipe],
  template: `
    <tc-list [attr.aria-label]="label()">
      @for (item of items(); track item.type + ' ' + item.url) {
        @if (designOf(item); as design) {
          <tc-list-row
            button
            data-testid="artifact"
            [attr.data-type]="item.type"
            [attr.data-issue]="design.number"
            (click)="openDesign.emit(design)"
          >
            @if (designLeading(); as leading) {
              <span tc-row-leading><ng-container *ngTemplateOutlet="leading; context: { $implicit: design }" /></span>
            }
            <span tc-row-title
              >{{ item.title }} <span class="tc-sr-only">{{ 'designs.row.open' | transloco }}</span></span
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
            <span tc-row-title
              >{{ item.title }} <span class="tc-sr-only">{{ 'artifacts.opensGitHub' | transloco }}</span></span
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
    </tc-list>
  `,
  styles: `
    .artifact__awaiting {
      color: var(--warning-text);
      font-size: var(--fs-xs);
      font-weight: var(--fw-semibold);
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

  /** A design issue row was pressed: open it in the viewer. */
  readonly openDesign = output<Artifact & { readonly number: number }>();

  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

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
