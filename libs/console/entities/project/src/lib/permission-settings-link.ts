import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, ButtonVariant, Icon } from '@console/shared/ui';

/**
 * «Open installation settings» (#792): the way out of `github-permission-not-accepted`, where the owner accepts the
 * console app's new permissions on GitHub. `url` must come from `permissionSettingsUrlOf` (github.com only). Inside a
 * state block the host carries `tc-state-action`, like `tc-project-setup-link`.
 */
@Component({
  selector: 'tc-permission-settings-link',
  imports: [Button, Icon, TranslocoPipe],
  template: `
    <a
      tc-button
      data-testid="permission-settings-link"
      target="_blank"
      rel="noopener noreferrer"
      [variant]="variant()"
      [href]="url()"
      >{{ 'permissionNotAccepted.open' | transloco
      }}<span class="tc-sr-only"> {{ 'settings.common.external' | transloco }}</span>
      <tc-icon name="external" size="sm" />
    </a>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-permission-settings-link' },
})
export class PermissionSettingsLink {
  readonly url = input.required<string>();
  readonly variant = input<ButtonVariant>('primary');
}
