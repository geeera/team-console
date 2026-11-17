import { computed, inject, type Signal } from '@angular/core';
import { DeploymentStore } from '@console/entities/app-info';
import { APP_NAME, appNameOf } from '@shared/contracts';

/** The name the installed icon gets (#237): «Team Console Dev» on dev, the plain name until the Worker says where. */
export function injectAppName(): Signal<string> {
  const deployment = inject(DeploymentStore);
  return computed(() => {
    const environment = deployment.environment();
    return environment === null ? APP_NAME : appNameOf(environment);
  });
}
