import { DOCUMENT } from '@angular/common';
import { booleanAttribute, ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '../icon/icon';
import { externalHrefOf, frameSrcOf, trustedFrameSrc } from './frame-src';

/**
 * An embedded page (Paper Desk preview): the page in a sandboxed frame when `src` passes `frameSrcOf` against
 * `allowedOrigins` (never the console's own origin), otherwise a "can't be shown here" note. Both always carry an "Open in a new tab" link, because a
 * page behind a login or with anti-framing headers fails silently inside a frame.
 *
 * The sandbox never grants top navigation, the frame sends no referrer and is delegated no features; these are
 * static attributes on purpose (Angular refuses to bind them, and nothing should change them per page).
 *
 * ```html
 * <tc-frame [src]="url" [allowedOrigins]="origins" [title]="'Storybook'" />
 * ```
 */
@Component({
  selector: 'tc-frame',
  imports: [Icon, TranslocoPipe],
  template: `
    @if (trusted(); as trusted) {
      @if (profile() === 'design') {
        <!-- The strict profile (#277 spec §R): scripts only — no same-origin, forms, popups or top navigation. -->
        <iframe
          class="tc-frame__view"
          data-testid="frame"
          [src]="trusted"
          [title]="title()"
          sandbox="allow-scripts"
          allow=""
          referrerpolicy="no-referrer"
          loading="lazy"
        ></iframe>
      } @else {
        <iframe
          class="tc-frame__view"
          data-testid="frame"
          [src]="trusted"
          [title]="title()"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
          loading="lazy"
        ></iframe>
      }
    } @else {
      <div class="tc-frame__refused" data-testid="frame-refused">
        <p class="tc-frame__refused-title">{{ 'ui.frame.refusedTitle' | transloco }}</p>
        <p class="tc-frame__refused-hint">{{ 'ui.frame.refusedHint' | transloco }}</p>
      </div>
    }
    @if (href(); as href) {
      <a class="tc-frame__open" data-testid="frame-open" [href]="href" target="_blank" rel="noopener noreferrer">
        <span class="tc-frame__host">{{ host() }}</span>
        <span class="tc-frame__open-label"
          >{{ 'ui.frame.open' | transloco }}<span class="tc-sr-only"> {{ 'ui.frame.newTab' | transloco }}</span></span
        >
        <tc-icon name="external" size="sm" />
      </a>
    }
  `,
  styleUrl: './frame.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-frame',
    '[class.tc-frame--refused]': 'trusted() === null',
    '[class.tc-frame--fill]': 'fill()',
  },
})
export class Frame {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly ownOrigin = inject(DOCUMENT).location.origin;

  /** The page to show; untrusted until `frameSrcOf` says otherwise. */
  readonly src = input.required<string>();
  /** Exact origins this frame may load (`EmbedOriginsDto` for a project); empty means "never embed". */
  readonly allowedOrigins = input.required<readonly string[]>();
  /** The frame's accessible name, already translated. */
  readonly title = input.required<string>();
  /**
   * `page` (default): a Storybook or a demo site, which may keep its origin and open links. `design` (#277): an HTML
   * wireframe from GitHub Pages — `sandbox="allow-scripts"` alone, so the page runs but can neither read its own
   * origin's storage nor open or navigate anything. The two sandboxes are static attributes under `@if`: Angular
   * refuses to bind them, and nothing should change them per page.
   */
  readonly profile = input<'page' | 'design'>('page');
  /** Fills its container (the viewer's stage) instead of a page-wide aspect box, and leaves the link to the caller. */
  readonly fill = input(false, { transform: booleanAttribute });

  protected readonly trusted = computed(() =>
    trustedFrameSrc(this.sanitizer, this.src(), this.allowedOrigins(), this.ownOrigin),
  );
  protected readonly href = computed(
    () => frameSrcOf(this.src(), this.allowedOrigins(), this.ownOrigin) ?? externalHrefOf(this.src()),
  );
  protected readonly host = computed(() => {
    const href = this.href();
    return href === null ? '' : new URL(href).host;
  });
}
