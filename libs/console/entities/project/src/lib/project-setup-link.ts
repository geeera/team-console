import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, ButtonVariant } from '@console/shared/ui';
import { projectSetupRouteOf } from './project-routes';

/**
 * «Open project setup»: the one-tap way out of an error whose fix lives on the project's setup page (the console app
 * not installed on the repository, #366). Settings no longer lists projects (#194), so a link to `/settings` would
 * stop one screen short. Inside a state block the host carries `tc-state-action`, so the link sits right after the
 * error text in tab order.
 */
@Component({
  selector: 'tc-project-setup-link',
  imports: [Button, RouterLink, TranslocoPipe],
  template: `
    <a tc-button data-testid="project-setup-link" [variant]="variant()" [routerLink]="route()">{{
      'settings.setup.openSetup' | transloco
    }}</a>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-project-setup-link' },
})
export class ProjectSetupLink {
  readonly slug = input.required<string>();
  readonly variant = input<ButtonVariant>('primary');

  protected readonly route = computed(() => projectSetupRouteOf(this.slug()));
}
