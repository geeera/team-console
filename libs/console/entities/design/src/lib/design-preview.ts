import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { DesignManifests } from './design-manifests.store';
import { screenSrcOf, thumbnailOf, type DesignManifest } from './design.model';

/**
 * A design's thumbnail (#277; the question cards of #276 reuse it): the first screen of the issue's manifest as a
 * plain `<img>` from the api Worker's file route — never SVG, never a frame. Decorative on purpose (`alt=""`): the
 * row or card beside it names the design. Loads the manifest through `DesignManifests` unless one is given.
 *
 * ```html
 * <tc-design-preview [slug]="slug" [issue]="277" />
 * ```
 */
@Component({
  selector: 'tc-design-preview',
  imports: [TranslocoPipe],
  template: `
    @if (manifestState(); as state) {
      @switch (state.kind) {
        @case ('ready') {
          @if (src(); as src) {
            @if (failed()) {
              <span class="preview__placeholder" data-testid="design-thumb-failed" aria-hidden="true">
                {{ placeholderKey('failed') | transloco }}
              </span>
            } @else {
              <img
                class="preview__img"
                data-testid="design-thumb"
                [src]="src"
                alt=""
                loading="lazy"
                decoding="async"
                (error)="onFailed(state.manifest.sha)"
              />
            }
          } @else {
            <span class="preview__placeholder" data-testid="design-thumb-none" aria-hidden="true">
              {{ placeholderKey(state.manifest.interactive === null ? 'none' : 'html') | transloco }}
            </span>
          }
        }
        @case ('loading') {
          <span class="preview__skeleton" data-testid="design-thumb-loading" aria-hidden="true"></span>
        }
        @default {
          <span class="preview__placeholder" data-testid="design-thumb-failed" aria-hidden="true">
            {{ placeholderKey('failed') | transloco }}
          </span>
        }
      }
    }
  `,
  styleUrl: './design-preview.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-design-preview',
    '[class.tc-design-preview--card]': 'variant() === "card"',
    '[class.tc-design-preview--worded]': 'worded()',
  },
})
export class DesignPreview {
  private readonly manifests = inject(DesignManifests);

  readonly slug = input.required<string>();
  readonly issue = input.required<number>();
  /** `thumb` (default): the 56 px square of a list row; `card`: a wide preview the width of its card. */
  readonly variant = input<'thumb' | 'card'>('thumb');
  /**
   * The placeholder says in words what is missing («Без картинок», «Картинка не загрузилась»), for a tile large
   * enough to read (an artifact card, #766); otherwise a mark. Decorative either way: the card's summary says it too.
   */
  readonly worded = input(false);
  /** A manifest the caller already holds; otherwise the shared store loads it. */
  readonly manifest = input<DesignManifest | null>(null);
  /**
   * The path of the screen to show (a card's row of previews, #276); `null` shows the thumbnail. A path the manifest
   * does not list, or a screen too large to serve, shows the "nothing" placeholder.
   */
  readonly screen = input<string | null>(null);

  protected readonly manifestState = computed(() => {
    const given = this.manifest();
    return given === null ? this.manifests.stateOf(this.slug(), this.issue())() : { kind: 'ready' as const, manifest: given };
  });
  protected readonly src = computed(() => {
    const state = this.manifestState();
    if (state.kind !== 'ready') {
      return null;
    }
    const path = this.screen();
    const screen =
      path === null
        ? thumbnailOf(state.manifest)
        : (state.manifest.screens.find((candidate) => candidate.path === path && !candidate.tooLarge) ?? null);
    return screen === null ? null : screenSrcOf(this.slug(), state.manifest, screen);
  });
  protected placeholderKey(reason: 'none' | 'html' | 'failed'): string {
    if (this.worded()) {
      return `designs.tile.${reason}`;
    }
    return { none: 'designs.row.thumbNone', html: 'designs.row.thumbHtml', failed: 'designs.row.thumbFailed' }[reason];
  }

  /** The image did not load; reset when the source changes. */
  protected readonly failed = linkedSignal<string | null, boolean>({ source: this.src, computation: () => false });

  /**
   * The thumbnail did not arrive — usually because the design moved to another commit and the Worker answers 404
   * for the old one. The shared list is read again once per commit; a new commit gives a new source and the image
   * tries again. A manifest the caller handed in is theirs to refresh.
   */
  protected async onFailed(sha: string): Promise<void> {
    const recovered =
      this.manifest() === null && (await this.manifests.recover(this.slug(), this.issue(), sha));
    const state = this.manifestState();
    if (!recovered || (state.kind === 'ready' && state.manifest.sha === sha)) {
      this.failed.set(true);
    }
  }
}
