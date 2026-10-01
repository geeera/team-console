import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Card, CardStamp, Chip, Recommendation } from '@console/shared/ui';
import { QuestionItem } from './question.model';

let nextCardId = 0;

/**
 * One waiting item as a Paper Desk decision card. Every text of the item is untrusted and is interpolated, never
 * bound as HTML; an item whose author is not trusted carries a visible mark. The answer controls are projected
 * (`[tc-question-actions]`) — the card itself never acts.
 */
@Component({
  selector: 'tc-question-card',
  imports: [Card, Chip, Recommendation, TranslocoPipe],
  template: `
    <tc-card flush [stamp]="stamp()" role="article" [attr.aria-labelledby]="titleId">
      <span tc-card-kind>
        @if (showProject()) {
          <tc-chip tone="accent" data-testid="project-tag">{{ item().project.name }}</tc-chip>
        }
        {{ 'questions.section.' + item().section | transloco }}
      </span>
      <span tc-card-number>#{{ item().number }}</span>
      <h2 tc-card-title [id]="titleId">{{ item().title }}</h2>
      @if (!item().authorTrusted) {
        <p class="question__untrusted" data-testid="untrusted">
          <tc-chip tone="warning" dot>{{ 'questions.untrusted' | transloco }}</tc-chip>
          <span>{{ 'questions.untrustedHint' | transloco }}</span>
        </p>
      }
      @if (item().ask; as ask) {
        <tc-recommendation [label]="'questions.recommends' | transloco">{{ ask }}</tc-recommendation>
      }
      @if (item().body; as body) {
        <details class="question__details">
          <summary>{{ 'questions.details' | transloco }}</summary>
          <p class="question__body">{{ body }}</p>
        </details>
      }
      <ng-content select="[tc-question-actions]" />
      @if (item().url; as url) {
        <a tc-card-meta class="question__link" [href]="url" target="_blank" rel="noopener noreferrer">{{
          'questions.openOnGitHub' | transloco: { n: item().number }
        }}</a>
      }
    </tc-card>
  `,
  styleUrl: './question-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-question-card' },
})
export class QuestionCard {
  readonly item = input.required<QuestionItem>();
  /** Cross-project lists tag every card with its project. */
  readonly showProject = input(false, { transform: booleanAttribute });
  /** The ink stamp while an answered card folds away. */
  readonly stamp = input<CardStamp | null>(null);

  protected readonly titleId = `tc-question-title-${nextCardId++}`;
}
