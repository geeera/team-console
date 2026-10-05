import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { localDayOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Chip, List, ListRow } from '@console/shared/ui';
import { Artifact } from './artifact.model';

/**
 * Artifacts as rows that open their github.com page in a new tab. Titles are GitHub text and only ever interpolated;
 * the url was checked to be a github.com page before it got here.
 */
@Component({
  selector: 'tc-artifact-list',
  imports: [Chip, List, ListRow, TranslocoPipe],
  template: `
    <tc-list [attr.aria-label]="label()">
      @for (item of items(); track item.type + ' ' + item.url) {
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
    </tc-list>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtifactList {
  private readonly transloco = inject(TranslocoService);

  readonly items = input.required<readonly Artifact[]>();
  /** The list's accessible name. */
  readonly label = input.required<string>();

  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected dayOf(iso: string): string {
    return localDayOf(iso, this.lang());
  }
}
