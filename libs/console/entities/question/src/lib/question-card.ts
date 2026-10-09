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
import { withoutAskLine } from '@shared/owner-grammar';
import type { Section, TeamRecommendation } from '@shared/contracts';
import { Card, CardStamp, Chip, Frame, Icon, Recommendation } from '@console/shared/ui';
import { previewTargetOf } from './preview-target';
import { askOutcomesOf, plainAskOf, plainDetailsOf, type PlainAsk } from './question-text';
import { QuestionItem } from './question.model';

let nextCardId = 0;

interface OutcomeLabels {
  readonly approve: string;
  readonly reject: string;
}

/** The outcome labels per section (#276 copy); action items (`owner`, `local`) have no outcomes. */
const OUTCOME_LABELS: Readonly<Record<Section, OutcomeLabels | null>> = {
  design: { approve: 'questions.outcome.ifApproveDesign', reject: 'questions.outcome.ifReject' },
  question: { approve: 'questions.outcome.ifApprove', reject: 'questions.outcome.ifReject' },
  release: { approve: 'questions.outcome.ifGo', reject: 'questions.outcome.ifNoGo' },
  owner: null,
  local: null,
};

interface Outcome {
  readonly key: 'approve' | 'reject';
  readonly label: string;
  readonly text: string;
}

/**
 * "The team recommends": the recommended answer as a verb and the team's reason (#276), or — for a team item with
 * neither — the answer line's own recommended option in plain words (#204). Never shown without a recognised
 * recommendation (#210), never for an action item (#291, see `isAction` instead), and never for an item from
 * outside the team (#210, #211): marking its own answer line `(рекомендую)` never makes it the team's advice.
 */
type Advice =
  | { readonly kind: 'verdict'; readonly verbKey: string | null; readonly why: string | null }
  | { readonly kind: 'ask'; readonly ask: PlainAsk };

function verbKeyOf(section: Section, recommendation: TeamRecommendation): string {
  const verb = recommendation === 'approve' && section === 'design' ? 'approveDesign' : recommendation;
  return `questions.recommend.${verb}`;
}

/** An action item (#291): answered with "Готово" alone, never approve/reject, so it carries no recommendation. */
function isActionSection(section: Section): boolean {
  return section === 'owner' || section === 'local';
}

/**
 * One waiting item as a Paper Desk decision card, read top to bottom (#276): the title (the team's ru summary, with
 * the GitHub title as one muted line), the question, what the team recommends and why, the design previews, what
 * each answer leads to, the cost and risk, the answer controls, then the details and the GitHub link.
 *
 * Every text of the item is untrusted and only interpolated. The context fields come from the server as bounded
 * plain text and only for the team's own items; an outsider's item carries a visible mark, shows no outcomes and no
 * previews, and stays plain text everywhere. On the Designs and demo screen (#20, with `embedOrigins`) the body is
 * sanitised markdown plus a preview of the page it links to. The answer line itself is never shown. The answer
 * controls (`[tc-question-actions]`) and the design previews (`[tc-question-previews]`, #277) are projected — the
 * card itself never acts.
 */
@Component({
  selector: 'tc-question-card',
  imports: [Card, Chip, Frame, Icon, Markdown, Recommendation, TranslocoPipe],
  template: `
    <tc-card flush [stamp]="stamp()" role="article" [attr.aria-labelledby]="titleId">
      <span tc-card-kind>
        @if (showProject()) {
          <tc-chip tone="accent" data-testid="project-tag">{{ item().project.name }}</tc-chip>
        }
        {{ 'questions.section.' + item().section | transloco }}
      </span>
      <span tc-card-number>#{{ item().number }}</span>
      <h2 tc-card-title [id]="titleId" tabindex="-1">{{ summary() ?? item().title }}</h2>
      @if (summary() !== null) {
        <p class="question__github-title" data-testid="github-title">
          {{ 'questions.onGitHub' | transloco }} {{ item().title }}
        </p>
      }
      @if (!item().authorTrusted) {
        <p class="question__untrusted" data-testid="untrusted">
          <tc-chip tone="warning" dot>{{ 'questions.untrusted' | transloco }}</tc-chip>
          <span>{{ 'questions.untrustedHint' | transloco }}</span>
        </p>
      }
      @if (question(); as question) {
        <p class="question__ask" data-testid="question-text">{{ question }}</p>
      }
      @if (isAction()) {
        <p class="question__ask" data-testid="action-text">{{ 'questions.actionHint' | transloco }}</p>
      }
      @if (advice(); as advice) {
        <tc-recommendation [label]="'questions.recommends' | transloco" data-testid="recommendation">
          @if (advice.kind === 'verdict') {
            @if (advice.verbKey; as verbKey) {
              {{ verbKey | transloco }}
            }
            {{ advice.why }}
          } @else if (advice.ask.kind === 'text') {
            {{ advice.ask.text }}
          } @else {
            {{ 'answer.command.' + advice.ask.command | transloco }}
          }
        </tc-recommendation>
      }
      @if (item().section === 'design') {
        @if (item().authorTrusted) {
          <ng-content select="[tc-question-previews]" />
        } @else {
          <p class="question__note" data-testid="previews-untrusted">
            {{ 'questions.previews.untrusted' | transloco }}
          </p>
        }
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
      @if (outcomes().length > 0) {
        <dl class="question__outcomes" data-testid="outcomes">
          @for (outcome of outcomes(); track outcome.key) {
            <div class="question__outcome" [attr.data-outcome]="outcome.key">
              <dt>{{ outcome.label | transloco }}</dt>
              <dd>{{ outcome.text }}</dd>
            </div>
          }
        </dl>
      }
      @if (cost(); as cost) {
        <p class="question__cost" data-testid="cost">
          @if (cost.text; as text) {
            <strong>{{ 'questions.cost' | transloco }}</strong> {{ text }}
          } @else {
            {{ 'questions.costMissing' | transloco }}
          }
        </p>
      }
      <ng-content select="[tc-question-actions]" />
      @if (details(); as details) {
        <details class="question__details" [open]="embedOrigins() !== null">
          <summary>{{ 'questions.details' | transloco }}</summary>
          @if (isRich()) {
            <tc-markdown
              class="question__markdown"
              data-testid="markdown"
              [text]="details"
              (rendered)="onRendered($event)"
            />
          } @else {
            <p class="question__body">{{ details }}</p>
          }
        </details>
      }
      @if (item().url; as url) {
        <a tc-card-meta class="question__link" [href]="url" target="_blank" rel="noopener noreferrer"
          >{{ 'questions.openOnGitHub' | transloco: { n: item().number }
          }}<span class="tc-sr-only"> {{ 'questions.opensGitHub' | transloco }}</span
          ><tc-icon name="external" size="sm" data-testid="external-icon"
        /></a>
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
  /** The server sends context only for the team's own items; the card does not take that on trust. */
  private readonly context = computed(() => (this.item().authorTrusted ? this.item().context : null));
  /** Markdown and a preview only on the Designs and demo screen, and only for the team's own items. */
  protected readonly isRich = computed(() => this.embedOrigins() !== null && this.item().authorTrusted);
  protected readonly summary = computed(() => this.context()?.summary ?? null);
  protected readonly question = computed(() => this.context()?.question ?? null);

  /**
   * Both outcomes from the body's sections; for a body without any (`structured: false`, older questions), from the
   * answer line's options, their commands stripped (#276 fallback).
   */
  protected readonly outcomes = computed((): readonly Outcome[] => {
    const item = this.item();
    const labels = OUTCOME_LABELS[item.section];
    if (labels === null || !item.authorTrusted) {
      return [];
    }
    const context = this.context();
    const texts = context?.structured === true ? context : askOutcomesOf(item.ask);
    const outcomes: Outcome[] = [];
    if (texts.ifApproved !== null) {
      outcomes.push({ key: 'approve', label: labels.approve, text: texts.ifApproved });
    }
    if (texts.ifRejected !== null) {
      outcomes.push({ key: 'reject', label: labels.reject, text: texts.ifRejected });
    }
    return outcomes;
  });

  /**
   * "The team recommends"; `null` for an action item (#291, never a recommendation to make), for an item from
   * outside the team (#210, #211 — marking its own answer line `(рекомендую)` never makes it the team's advice),
   * and whenever nothing recognised as a recommendation was found (#210) — a neutral fallback would still dress up
   * leftover options or an owner instruction as advice, so the block is better absent than wrong.
   */
  protected readonly advice = computed((): Advice | null => {
    const item = this.item();
    if (isActionSection(item.section) || !item.authorTrusted) {
      return null;
    }
    const why = this.context()?.why ?? null;
    if (item.recommendation !== null || why !== null) {
      const verbKey = item.recommendation === null ? null : verbKeyOf(item.section, item.recommendation);
      return { kind: 'verdict', verbKey, why };
    }
    // The outcomes already name each option; without a marked one there is nothing more to recommend.
    if (this.outcomes().length > 0) {
      return null;
    }
    const ask = plainAskOf(item.ask);
    return ask === null ? null : { kind: 'ask', ask };
  });

  /**
   * An action item (#291): a fixed console line in "вы" ("Нажмите «Готово», когда сделаете.") under the title and
   * the question (if any), never under "The team recommends". The plugin's own answer line can mix in its "ты"
   * grammar and free text the console does not control, so it is never shown here, not even in part.
   */
  protected readonly isAction = computed(() => isActionSection(this.item().section));

  /** The cost line; for a money decision without one, a prompt to ask the PM (#276). */
  protected readonly cost = computed((): { readonly text: string | null } | null => {
    const item = this.item();
    if (!item.authorTrusted) {
      return null;
    }
    const text = this.context()?.costAndRisk ?? null;
    return text !== null || item.category === 'money' ? { text } : null;
  });

  /**
   * The body under "Details", never with the answer line: as markdown on the Designs and demo screen (#20), without
   * markup everywhere else; `null` hides the disclosure when nothing is left to read.
   */
  protected readonly details = computed(() => {
    const body = this.item().body;
    if (body === null) {
      return null;
    }
    const text = this.embedOrigins() === null ? plainDetailsOf(body) : withoutAskLine(body).trim();
    return text === '' ? null : text;
  });
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
