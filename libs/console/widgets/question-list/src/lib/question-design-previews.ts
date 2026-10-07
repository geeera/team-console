import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DesignManifests, DesignPreview, DesignSummary, previewScreensOf } from '@console/entities/design';
import type { ViewerMode } from '@console/features/design-viewer';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, StateBlock } from '@console/shared/ui';

/** How many screens a card shows before «+N» (#276 §3). */
export const CARD_PREVIEW_COUNT = 3;

/** Where the viewer should open: on a tapped screen, or in a mode. */
export interface DesignOpenRequest {
  readonly screen?: string;
  readonly mode?: ViewerMode;
}

/**
 * A design card's previews (#276 §3–§4): up to three screens as buttons that open the viewer on that screen, the
 * last with «+N» when there are more, then «Все экраны (N)» and the design's summary line. Three skeletons while the
 * list loads, a note when the team attached no screens, and a retry when the list could not be read — the answer
 * buttons below stay usable in every state. The images stay decorative; each button carries the screen's name.
 */
@Component({
  selector: 'tc-question-design-previews',
  imports: [Button, DesignPreview, DesignSummary, StateBlock, TranslocoPipe],
  template: `
    @switch (view()) {
      @case ('loading') {
        <div class="previews__list" data-testid="question-previews-loading" aria-hidden="true">
          @for (slot of skeletons; track slot) {
            <tc-design-preview class="previews__thumb" variant="card" [slug]="slug()" [issue]="issue()" />
          }
        </div>
      }
      @case ('failed') {
        <tc-state-block
          kind="error"
          compact
          data-testid="question-previews-failed"
          [title]="'questions.previews.failed' | transloco"
        >
          <button tc-button tc-state-action size="sm" type="button" (click)="retry()">
            {{ 'ui.error.retry' | transloco }}
          </button>
        </tc-state-block>
      }
      @case ('none') {
        <tc-state-block
          kind="empty"
          compact
          icon="grid"
          data-testid="question-previews-none"
          [title]="'questions.previews.none' | transloco"
        >
          @if (hasInteractive()) {
            <button
              tc-button
              tc-state-action
              size="sm"
              type="button"
              data-testid="question-previews-open"
              (click)="openMode('interactive')"
            >
              {{ 'designs.row.open' | transloco }}
            </button>
          }
        </tc-state-block>
      }
      @case ('ready') {
        @if (shown().length > 0) {
          <ul
            class="previews__list"
            data-testid="question-previews"
            [attr.aria-label]="'questions.previews.label' | transloco: { n: total() }"
          >
            @for (screen of shown(); track screen.path; let i = $index, last = $last) {
              <li>
                <button
                  type="button"
                  class="previews__thumb"
                  data-testid="question-preview"
                  [attr.data-path]="screen.path"
                  [attr.aria-label]="
                    'questions.previews.thumbAria'
                      | transloco: { i: i + 1, n: total(), caption: screen.caption }
                  "
                  (click)="openScreen(screen.path)"
                >
                  <tc-design-preview
                    variant="card"
                    [slug]="slug()"
                    [issue]="issue()"
                    [screen]="screen.path"
                  />
                  @if (last && more() > 0) {
                    <span class="previews__more" data-testid="question-previews-more" aria-hidden="true"
                      >+{{ more() }}</span
                    >
                  }
                </button>
              </li>
            }
          </ul>
        }
        <div class="previews__foot">
          <button
            tc-button
            variant="quiet"
            size="sm"
            type="button"
            data-testid="question-previews-all"
            (click)="openMode('grid')"
          >
            {{ 'questions.previews.all' | transloco: { n: total() } }}
          </button>
          <tc-design-summary class="previews__summary" [slug]="slug()" [issue]="issue()" />
        </div>
      }
    }
  `,
  styleUrl: './question-design-previews.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-question-design-previews' },
})
export class QuestionDesignPreviews {
  private readonly manifests = inject(DesignManifests);

  readonly slug = input.required<string>();
  readonly issue = input.required<number>();
  /** The owner asked to see the design; the list opens the viewer with the card's answers. */
  readonly opened = output<DesignOpenRequest>();

  protected readonly skeletons = Array.from({ length: CARD_PREVIEW_COUNT }, (_, index) => index);

  private readonly state = computed(() => this.manifests.stateOf(this.slug(), this.issue())());
  private readonly manifest = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.manifest : null;
  });
  protected readonly shown = computed(() => {
    const manifest = this.manifest();
    return manifest === null ? [] : previewScreensOf(manifest).slice(0, CARD_PREVIEW_COUNT);
  });
  protected readonly total = computed(() => this.manifest()?.screens.length ?? 0);
  protected readonly more = computed(() => this.total() - this.shown().length);
  protected readonly hasInteractive = computed(() => (this.manifest()?.interactive ?? null) !== null);

  /**
   * `none` only when there is not a single screen; screens all too large to preview still get «Все экраны», where
   * the viewer says why each one is not shown.
   */
  protected readonly view = computed((): 'loading' | 'failed' | 'none' | 'ready' => {
    const state = this.state();
    if (state.kind !== 'ready') {
      return state.kind;
    }
    return state.manifest.screens.length === 0 ? 'none' : 'ready';
  });

  protected openScreen(path: string): void {
    this.opened.emit({ screen: path });
  }

  protected openMode(mode: ViewerMode): void {
    this.opened.emit({ mode });
  }

  protected retry(): void {
    void this.manifests.reload(this.slug(), this.issue());
  }
}
