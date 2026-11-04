import { ChangeDetectionStrategy, Component, effect, inject, untracked } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { DeploymentStore } from '@console/entities/app-info';
import { AccessSession } from '@console/shared/api';
import { Sheet } from '@console/shared/ui';
import { AppShell } from '@console/widgets/app-shell';
import { appNameOf } from '@shared/contracts';
import { SessionExpired } from './session-expired';
import { UpdateBanner } from './update-banner';

@Component({
  imports: [AppShell, SessionExpired, UpdateBanner],
  selector: 'tc-root',
  template: `
    @if (session.expired()) {
      <tc-session-expired />
    } @else {
      <tc-app-shell />
    }
    <tc-update-banner />
  `,
  // A block, so the update banner's sticky bottom has the whole page to travel in.
  styles: `
    :host {
      display: block;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly session = inject(AccessSession);

  constructor() {
    const deployment = inject(DeploymentStore);
    const title = inject(Title);
    const meta = inject(Meta);
    const sheet = inject(Sheet);
    void deployment.ensureLoaded();
    // Sheets live in the overlay container, not in the shell the swap removes: one left open would sit over the
    // sign-in, modal and focus-trapped, still showing the failure of the call Access redirected (#367).
    effect(() => {
      if (this.session.expired()) {
        untracked(() => sheet.closeAll());
      }
    });
    // index.html is one static file for every environment (ngsw hashes it), so the window title and the name iOS
    // offers for the Home Screen are set here once the Worker says where we are (#237). Production keeps its own.
    effect(() => {
      const environment = deployment.environment();
      if (environment === null) {
        return;
      }
      const name = appNameOf(environment);
      title.setTitle(name);
      meta.updateTag({ name: 'apple-mobile-web-app-title', content: name });
    });
  }
}
