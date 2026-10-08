import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { DeploymentStore } from '@console/entities/app-info';
import { AccessSession } from '@console/shared/api';
import { AppShell } from '@console/widgets/app-shell';
import { appNameOf } from '@shared/contracts';
import { SessionExpired } from './session-expired';

@Component({
  imports: [AppShell, SessionExpired],
  selector: 'tc-root',
  template: `
    @if (session.expired()) {
      <tc-session-expired />
    } @else {
      <tc-app-shell />
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
    void deployment.ensureLoaded();
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
