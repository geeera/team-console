import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '@console/shared/ui';

/**
 * iPhone Safari's "Add to Home Screen" in three steps (#36 design): iOS sends web push only to Home Screen apps.
 * Safari's own buttons appear as their glyphs with their names for screen readers; Apple's iOS 26/27 wording.
 * The numbered steps stay here until a second feature needs them (design note).
 */
@Component({
  selector: 'tc-push-install-guide',
  imports: [Icon, TranslocoPipe],
  template: `
    <ol class="guide" [attr.aria-label]="'push.install.steps' | transloco" data-testid="push-install-guide">
      <li class="guide__step">
        <span class="guide__n" aria-hidden="true">1</span>
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
      </li>
      <li class="guide__step">
        <span class="guide__n" aria-hidden="true">2</span>
        <p>{{ 'push.install.s2' | transloco }}</p>
      </li>
      <li class="guide__step">
        <span class="guide__n" aria-hidden="true">3</span>
        <p>{{ 'push.install.s3' | transloco }}</p>
      </li>
    </ol>
  `,
  styleUrl: './install-guide.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstallGuide {}
