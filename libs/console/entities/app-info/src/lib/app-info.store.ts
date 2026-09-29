import { computed, inject, Injectable, signal } from '@angular/core';
import { APP_CONFIG } from '@console/shared/config';

/** Read model of the running client. Signals only, so views stay zoneless-friendly. */
@Injectable({ providedIn: 'root' })
export class AppInfoStore {
  private readonly config = signal(inject(APP_CONFIG));

  readonly name = computed(() => this.config().name);
  readonly version = computed(() => this.config().version);
  readonly builtAt = computed(() => this.config().builtAt);
  readonly isLocalBuild = computed(() => this.config().builtAt === 'local');
}
