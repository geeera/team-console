import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { StateBlock } from '@console/shared/ui';

/** `/overview` (ADR 0001 decision 24) until #18 fills it. */
@Component({
  selector: 'tc-overview-page',
  imports: [StateBlock, TranslocoPipe],
  template: `
    <div class="tc-page">
      <h1 class="tc-page__title">{{ 'overview.title' | transloco }}</h1>
      <tc-state-block
        kind="empty"
        [title]="'space.placeholderTitle' | transloco"
        [description]="'overview.placeholderHint' | transloco"
      />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {}
