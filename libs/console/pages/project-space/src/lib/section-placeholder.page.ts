import { ChangeDetectionStrategy, Component, computed, inject, input, isDevMode } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { isSpaceSection, SpaceSection } from '@console/entities/project';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { List, ListRow, StateBlock } from '@console/shared/ui';
import { map } from 'rxjs';

/** Rows the placeholder renders with `?e2e-tall=1` so an e2e can scroll a space (developer builds only). */
export const TALL_ROWS = 60;

/**
 * Stands in for a section until its own issue replaces it (ADR 0001 items 13, 15–17). Shows the
 * shared empty block; the section name comes from the route's `data.section`.
 */
@Component({
  selector: 'tc-section-placeholder-page',
  imports: [List, ListRow, StateBlock, TranslocoPipe],
  template: `
    <tc-state-block
      kind="empty"
      [title]="'space.placeholderTitle' | transloco"
      [description]="'space.placeholderHint' | transloco: { section: sectionName() }"
    />
    @if (tall()) {
      <tc-list [attr.aria-label]="sectionName()" data-testid="tall-list">
        @for (row of rows; track row) {
          <tc-list-row
            ><span tc-row-title>{{ 'space.tallRow' | transloco: { n: row } }}</span></tc-list-row
          >
        }
      </tc-list>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SectionPlaceholderPage {
  private readonly route = inject(ActivatedRoute);
  private readonly transloco = inject(TranslocoService);

  readonly slug = input.required<string>();

  protected readonly rows = Array.from({ length: TALL_ROWS }, (_, index) => index + 1);
  protected readonly tall = toSignal(
    this.route.queryParamMap.pipe(map((params) => isDevMode() && params.get('e2e-tall') === '1')),
    { initialValue: false },
  );

  private readonly section = toSignal(
    this.route.data.pipe(
      map((data): SpaceSection | null => (isSpaceSection(data['section']) ? data['section'] : null)),
    ),
    { initialValue: null },
  );
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly sectionName = computed(() => {
    this.lang();
    const section = this.section();
    return section === null ? '' : this.transloco.translate(`space.${section}`);
  });
}
