import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { DeploymentStore } from '@console/entities/app-info';
import { AppShell } from '@console/widgets/app-shell';
import { appNameOf } from '@shared/contracts';

@Component({
  imports: [AppShell],
  selector: 'tc-root',
  template: '<tc-app-shell />',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
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
