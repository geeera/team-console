import { DOCUMENT } from '@angular/common';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Markdown, type RenderedMarkdown } from '@console/shared/markdown';
import { Card, CardStamp, Chip, Frame, Recommendation } from '@console/shared/ui';
import { previewTargetOf } from './preview-target';
import { QuestionItem } from './question.model';

let nextCardId = 0;

/**
 * One waiting item as a Paper Desk decision card. Every text of the item is untrusted: the title and the
 * recommendation are interpolated, and the body is plain text, or — on the Designs and demo screen (#20, with
 * `embedOrigins`) — sanitised markdown plus a preview of the page it links to. An item whose author is not trusted
 * carries a visible mark and stays plain text everywhere, with no links and no preview. The answer controls are projected (`[tc-question-actions]`)
 * — the card itself never acts.
 */
@Component({
  selector: 'tc-question-card',
  imports: [Card, Chip, Frame, Markdown, Recommendation, TranslocoPipe],
  template: `
    <tc-card flush [stamp]="stamp()" role="article" [attr.aria-labelledby]="titleId">
      <span tc-card-kind>
        @if (showProject()) {
          <tc-chip tone="accent" data-testid="project-tag">{{ item().project.name }}</tc-chip>
        }
        {{ 'questions.section.' + item().section | transloco }}
      </span>
      <span tc-card-number>#{{ item().number }}</span>
      <h2 tc-card-title [id]="titleId" tabindex="-1">{{ item().title }}</h2>
      @if (!item().authorTrusted) {
        <p class="question__untrusted" data-testid="untrusted">
          <tc-chip tone="warning" dot>{{ 'questions.untrusted' | transloco }}</tc-chip>
          <span>{{ 'questions.untrustedHint' | transloco }}</span>
        </p>
      }
      @if (item().ask; as ask) {
        <tc-recommendation [label]="'questions.recommends' | transloco">{{ ask }}</tc-recommendation>
      }
      @if (preview(); as preview) {
        <tc-frame
          class="question__preview"
          data-testid="preview"
          [src]="preview"
          [allowedOrigins]="embedOrigins() ?? []"
          [title]="'questions.preview' | transloco: { n: item().number }"
        />
      }
      @if (item().body; as body) {
        <details class="question__details" [open]="embedOrigins() !== null">
          <summary>{{ 'questions.details' | transloco }}</summary>
          @if (isRich()) {
            <tc-markdown
              class="question__markdown"
              data-testid="markdown"
              [text]="body"
              (rendered)="onRendered($event)"
            />
          } @else {
            <p class="question__body">{{ body }}</p>
          }
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
  /**
   * The project's exact frame origins (#20): set, the body renders as sanitised markdown and the card previews the
   * page it links to; `null` (the default) keeps the plain-text card of Questions and Needs you.
   */
  readonly embedOrigins = input<readonly string[] | null>(null);

  private readonly ownOrigin = inject(DOCUMENT).location.origin;
  /** Markdown and a preview only on the Designs and demo screen, and only for the team's own items. */
  protected readonly isRich = computed(() => this.embedOrigins() !== null && this.item().authorTrusted);
  /** The links of the rendered body; reset whenever the body changes, until it has rendered again. */
  private readonly links = linkedSignal<string | null, readonly string[]>({
    source: () => this.item().body,
    computation: () => [],
  });

  protected readonly preview = computed(() => {
    const origins = this.embedOrigins();
    if (origins === null || this.item().body === null || !this.isRich()) {
      return null;
    }
    return previewTargetOf(this.links(), origins, this.ownOrigin);
  });

  protected onRendered(result: RenderedMarkdown): void {
    this.links.set(result.links);
  }

  protected readonly titleId = `tc-question-title-${nextCardId++}`;
}
