import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { isOrchestrationDto, type OrchestrationDto } from '@shared/contracts';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  ORCHESTRATION_CALL_TIMEOUT_MS,
  orchestrationFailureOf,
  type OrchestrationResult,
} from './orchestration-failure';

/** `/api/v1/projects/:slug/orchestration`: the slug is the route's, encoded; nothing else reaches the path. */
export function orchestrationUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/orchestration`;
}

/** An answer of the wrong shape is never shown: it reads as `error`, like a failed call. */
const MALFORMED = { ok: false, failure: { kind: 'error', slug: null } } as const;

/**
 * The console-driven run of a project (#1042 over the routes of #1039, ADR 0010): where it stands, Start and Stop.
 * Start and Stop send no members (the Worker refuses any), and both answer the run as it is after the command. Never
 * throws: every call is an `OrchestrationResult`, every answer is checked by `isOrchestrationDto` first.
 */
@Injectable({ providedIn: 'root' })
export class OrchestrationApi {
  private readonly http = inject(HttpClient);

  get(slug: string): Promise<OrchestrationResult<OrchestrationDto>> {
    return this.call(this.http.get<unknown>(orchestrationUrl(slug)));
  }

  start(slug: string): Promise<OrchestrationResult<OrchestrationDto>> {
    return this.call(this.http.post<unknown>(`${orchestrationUrl(slug)}/start`, {}));
  }

  stop(slug: string): Promise<OrchestrationResult<OrchestrationDto>> {
    return this.call(this.http.post<unknown>(`${orchestrationUrl(slug)}/stop`, {}));
  }

  private async call(request: Observable<unknown>): Promise<OrchestrationResult<OrchestrationDto>> {
    try {
      const value = await firstValueFrom(request.pipe(timeout(ORCHESTRATION_CALL_TIMEOUT_MS)));
      return isOrchestrationDto(value) ? { ok: true, value } : MALFORMED;
    } catch (error: unknown) {
      return { ok: false, failure: orchestrationFailureOf(error) };
    }
  }
}
