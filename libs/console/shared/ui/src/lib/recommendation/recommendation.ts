import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The team's recommendation on a decision card (Paper Desk `.rec`): a kicker, then the recommended answer as
 * plain text under a rule line. `label` arrives translated; the content is projected and must stay text.
 *
 * ```html
 * <tc-recommendation [label]="t('questions.recommends')">{{ item.ask }}</tc-recommendation>
 * ```
 */
@Component({
  selector: 'tc-recommendation',
  template: `
    <span class="tc-recommendation__label">{{ label() }}</span>
    <p class="tc-recommendation__choice"><ng-content /></p>
  `,
  styleUrl: './recommendation.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-recommendation' },
})
export class Recommendation {
  readonly label = input.required<string>();
}
