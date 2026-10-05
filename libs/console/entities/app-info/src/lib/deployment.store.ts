import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { isEnvironment, type Environment } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export const HEALTH_URL = '/api/v1/healthz';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which Worker environment this client talks to, from `GET /api/v1/healthz` (behind Access): the owner-facing
 * `wrangler … --env <env>` commands name it. Loaded once on demand; `null` until known or when unavailable.
 */
@Injectable({ providedIn: 'root' })
export class DeploymentStore {
  private readonly http = inject(HttpClient);
  private pending: Promise<void> | null = null;

  readonly environment = signal<Environment | null>(null);

  ensureLoaded(): Promise<void> {
    if (this.environment() !== null) {
      return Promise.resolve();
    }
    this.pending ??= (async () => {
      try {
        const body = await firstValueFrom(this.http.get<unknown>(HEALTH_URL));
        const environment = isRecord(body) ? body['environment'] : undefined;
        if (isEnvironment(environment)) {
          this.environment.set(environment);
        }
      } catch {
        // A hint for copy only: the screens show the `<env>` placeholder instead, and the next call tries again.
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}
