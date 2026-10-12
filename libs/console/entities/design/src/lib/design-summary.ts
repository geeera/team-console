import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe, TranslocoPluralPipe } from '@console/shared/i18n';
import { DesignManifests } from './design-manifests.store';
import { devicesOf } from './design.model';

/** One « · »-separated part of the line: a counted key (screens) or a plain one. */
interface Part {
  readonly key: string;
  readonly count: number | null;
}

/**
 * One line about a design for its list row (#277 spec §2): «#277 · 6 экранов · iPhone и Mac», «#277 · только
 * интерактивная версия» when there are no images, or «#277 · без картинок» when there is nothing at all. While the
 * manifest loads the number alone shows; a failed read keeps it, the row still opens the viewer, which says why.
 */
@Component({
  selector: 'tc-design-summary',
  imports: [TranslocoPipe, TranslocoPluralPipe],
  template: `<span data-testid="design-summary"
    >#{{ issue() }}@for (part of parts(); track part.key) {
      · {{ part.count === null ? (part.key | transloco) : (part.key | translocoPlural: part.count) }}
    }</span
  >`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DesignSummary {
  private readonly manifests = inject(DesignManifests);

  readonly slug = input.required<string>();
  readonly issue = input.required<number>();

  protected readonly parts = computed<readonly Part[]>(() => {
    const state = this.manifests.stateOf(this.slug(), this.issue())();
    if (state.kind !== 'ready') {
      return [];
    }
    const { manifest } = state;
    if (manifest.screens.length === 0) {
      return [{ key: manifest.interactive === null ? 'designs.row.none' : 'designs.row.htmlOnly', count: null }];
    }
    const devices = devicesOf(manifest);
    const deviceKey =
      devices.length === 2 ? 'designs.row.devices' : devices.length === 1 ? `designs.row.device.${devices[0]}` : null;
    return [
      { key: 'designs.row.screens', count: manifest.screens.length },
      ...(deviceKey === null ? [] : [{ key: deviceKey, count: null }]),
    ];
  });
}
