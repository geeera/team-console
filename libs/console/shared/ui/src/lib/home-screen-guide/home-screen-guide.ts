import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '../icon/icon';

/**
 * "Add to Home Screen" on iPhone and iPad in three steps (#36 design, shared since #761): Safari's own buttons appear
 * as their glyphs with their names for screen readers, in Apple's iOS 26/27 wording. `otherBrowser` is Chrome, Edge
 * or Firefox on iOS, whose Share button sits in the address bar; the last step is the caller's, translated.
 *
 * ```html
 * <tc-home-screen-guide [otherBrowser]="isChrome" [finalStep]="'…' | transloco" listId="steps-1" />
 * ```
 */
@Component({
  selector: 'tc-home-screen-guide',
  imports: [Icon, TranslocoPipe],
  template: `
    <ol
      class="guide"
      [attr.id]="listId()"
      [attr.aria-label]="'push.install.steps' | transloco"
      data-testid="push-install-guide"
    >
      <li class="guide__step">
        <span class="guide__n" aria-hidden="true">1</span>
        @if (otherBrowser()) {
          <div>
            <p data-testid="guide-step-other">
              {{ 'install.guide.s1OtherBefore' | transloco }}
              <span class="guide__key" aria-hidden="true"><tc-icon name="share" size="sm" /></span>
              {{ 'install.guide.s1OtherAfter' | transloco }}
            </p>
          </div>
        } @else {
          <div>
            <p>
              {{ 'push.install.s1Before' | transloco }}
              <span class="guide__key"
                ><tc-icon name="more" size="sm" /><span class="tc-sr-only">{{
                  'push.install.more' | transloco
                }}</span></span
              >
              {{ 'push.install.s1After' | transloco }}
            </p>
            <p class="guide__aside">
              {{ 'push.install.s1NoteBefore' | transloco }}
              <span class="guide__key"
                ><tc-icon name="share" size="sm" /><span class="tc-sr-only">{{
                  'push.install.share' | transloco
                }}</span></span
              >{{ 'push.install.s1NoteAfter' | transloco }}
            </p>
          </div>
        }
      </li>
      <li class="guide__step">
        <span class="guide__n" aria-hidden="true">2</span>
        <p>{{ 'push.install.s2' | transloco }}</p>
      </li>
      <li class="guide__step">
        <span class="guide__n" aria-hidden="true">3</span>
        <p>{{ finalStep() }}</p>
      </li>
    </ol>
  `,
  styleUrl: './home-screen-guide.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeScreenGuide {
  readonly otherBrowser = input(false, { transform: booleanAttribute });
  readonly finalStep = input.required<string>();
  /** For the toggle that shows the steps (`aria-controls`). */
  readonly listId = input<string | null>(null);
}
