import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '../icon/icon';
import { externalHrefOf, frameSrcOf, trustedFrameSrc } from './frame-src';

/**
 * An embedded page (Paper Desk preview): the page in a sandboxed frame when `src` passes `frameSrcOf` against
 * `allowedOrigins`, otherwise a "can't be shown here" note. Both always carry an "Open in a new tab" link, because a
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
      <iframe
        class="tc-frame__view"
        data-testid="frame"
        [src]="trusted"
        [title]="title()"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        loading="lazy"
      ></iframe>
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
  },
})
export class Frame {
  private readonly sanitizer = inject(DomSanitizer);

  /** The page to show; untrusted until `frameSrcOf` says otherwise. */
  readonly src = input.required<string>();
  /** Exact origins this frame may load (`EmbedOriginsDto` for a project); empty means "never embed". */
  readonly allowedOrigins = input.required<readonly string[]>();
  /** The frame's accessible name, already translated. */
  readonly title = input.required<string>();

  protected readonly trusted = computed(() =>
    trustedFrameSrc(this.sanitizer, this.src(), this.allowedOrigins()),
  );
  protected readonly href = computed(
    () => frameSrcOf(this.src(), this.allowedOrigins()) ?? externalHrefOf(this.src()),
  );
  protected readonly host = computed(() => {
    const href = this.href();
    return href === null ? '' : new URL(href).host;
  });
}
