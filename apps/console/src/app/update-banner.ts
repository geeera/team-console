import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Banner, Button, Icon } from '@console/shared/ui';
import { AppUpdates } from './app-updates';

/**
 * «Доступна новая версия · Обновить» (#306). Sticks to the bottom of the screen while the page scrolls under it and
 * settles after the content at the end, so it never covers the last action. The host is a live region that exists
 * before the banner does, so its arrival is announced.
 */
@Component({
  selector: 'tc-update-banner',
  imports: [Banner, Button, Icon, TranslocoPipe],
  template: `
    @if (updates.ready()) {
      <div class="tc-update">
        <div tc-banner tone="warning" data-testid="update-banner">
          <tc-icon tc-banner-icon name="refresh" />
          <p tc-banner-text>{{ 'app.update.ready' | transloco }}</p>
          <div tc-banner-actions>
            <button tc-button size="sm" type="button" data-testid="update-apply" (click)="apply()">
              {{ 'app.update.apply' | transloco }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      position: sticky;
      bottom: 0;
      z-index: var(--z-chrome);
      display: block;
    }

    .tc-update {
      max-width: var(--dialog-max-w);
      margin-inline: auto;
      padding: var(--space-3) calc(var(--space-4) + var(--safe-right))
        calc(var(--space-3) + var(--safe-bottom)) calc(var(--space-4) + var(--safe-left));
    }

    .tc-update [tc-banner] {
      box-shadow: var(--shadow-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status' },
})
export class UpdateBanner {
  protected readonly updates = inject(AppUpdates);

  protected apply(): void {
    void this.updates.activate();
  }
}
