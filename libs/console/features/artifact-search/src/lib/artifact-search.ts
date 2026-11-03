import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { Artifact } from '@console/entities/artifact';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Field, FieldControl } from '@console/shared/ui';
import { ARTIFACT_TYPES, type ArtifactType } from '@shared/contracts';
import { ARTIFACT_QUERY_MAX_LENGTH, artifactTypeCounts } from './filter-artifacts';

interface TypeOption {
  readonly type: ArtifactType | null;
  readonly key: string;
  readonly count: number;
}

/**
 * The Artifacts filter (#19): a search field and one toggle per type, over the list already loaded — nothing here
 * asks the Worker. The owner of the state (the page) gets every change and decides where it is kept.
 */
@Component({
  selector: 'tc-artifact-search',
  imports: [Button, Field, FieldControl, TranslocoPipe],
  template: `
    <tc-field [label]="'artifacts.search' | transloco">
      <input
        tcInput
        type="search"
        autocomplete="off"
        enterkeyhint="search"
        data-testid="artifact-query"
        [attr.maxlength]="maxLength"
        [value]="query()"
        (input)="onQuery($event)"
      />
    </tc-field>
    <div class="search__types" role="group" [attr.aria-label]="'artifacts.typeFilter' | transloco">
      @for (option of options(); track option.key) {
        <button
          tc-button
          size="sm"
          type="button"
          data-testid="artifact-type"
          [attr.data-type]="option.key"
          [variant]="option.type === type() ? 'primary' : 'quiet'"
          [attr.aria-pressed]="option.type === type()"
          (click)="typeChange.emit(option.type)"
        >
          {{ 'artifacts.type.' + option.key | transloco }}
          <span class="search__count">{{ option.count }}</span>
        </button>
      }
    </div>
    <p class="search__shown" aria-live="polite" data-testid="artifact-shown">
      {{ 'artifacts.shown' | transloco: { n: shown(), total: items().length } }}
    </p>
  `,
  styleUrl: './artifact-search.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtifactSearch {
  /** Every loaded artifact: the type counts come from here. */
  readonly items = input.required<readonly Artifact[]>();
  readonly type = input.required<ArtifactType | null>();
  readonly query = input.required<string>();
  /** How many artifacts the current filter shows, announced politely. */
  readonly shown = input.required<number>();

  readonly typeChange = output<ArtifactType | null>();
  readonly queryChange = output<string>();

  protected readonly maxLength = ARTIFACT_QUERY_MAX_LENGTH;
  protected readonly options = computed<readonly TypeOption[]>(() => {
    const counts = artifactTypeCounts(this.items());
    return [
      { type: null, key: 'all', count: this.items().length },
      ...ARTIFACT_TYPES.map((type) => ({ type, key: type, count: counts[type] })),
    ];
  });

  protected onQuery(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      this.queryChange.emit(target.value.slice(0, ARTIFACT_QUERY_MAX_LENGTH));
    }
  }
}
