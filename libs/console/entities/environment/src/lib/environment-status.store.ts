import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable, signal } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import {
  ENVIRONMENT_STATUS_URL,
  isEnvironmentStatusDto,
  type EnvironmentItemStatus,
  type EnvironmentStatusDto,
} from '@shared/environment';
import { firstValueFrom } from 'rxjs';

/** The answer did not have the shape #104 promises; nothing of it is used. */
export class UnexpectedEnvironmentResponse extends Error {
  constructor() {
    super(`unexpected response shape from ${ENVIRONMENT_STATUS_URL}`);
    this.name = 'UnexpectedEnvironmentResponse';
  }
}

@Injectable({ providedIn: 'root' })
export class EnvironmentStatusApi {
  private readonly http = inject(HttpClient);

  async load(): Promise<EnvironmentStatusDto> {
    const body = await firstValueFrom(this.http.get<unknown>(ENVIRONMENT_STATUS_URL));
    if (!isEnvironmentStatusDto(body)) {
      throw new UnexpectedEnvironmentResponse();
    }
    return body;
  }
}

/** Why the status could not be read, from the HTTP status only (never `detail`). */
export type EnvironmentProblem =
  | { readonly kind: 'failed' }
  | { readonly kind: 'offline' }
  /** 403: not the owner (the dev/stage service identity); the screen shows nothing of the list. */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'rate'; readonly retryAt: string };

const DEFAULT_RETRY_SECONDS = 60;

export function environmentProblemOf(error: unknown, now: number = Date.now()): EnvironmentProblem {
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'failed' };
  }
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return { kind: 'offline' };
  }
  if (problem.status === 403) {
    return { kind: 'forbidden' };
  }
  if (problem.status === 429) {
    const seconds = problem.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
    return { kind: 'rate', retryAt: new Date(now + seconds * 1000).toISOString() };
  }
  return { kind: 'failed' };
}

export type EnvironmentLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * This console's environment status (#104), shared by the Settings row and the Environment setup screen so both show
 * the same call. Statuses stay in memory only — never in `tc.state.v1` or any storage — and the last good answer is
 * kept through a failed re-check, so an offline screen shows it with its time.
 */
@Injectable({ providedIn: 'root' })
export class EnvironmentStatusStore {
  private readonly api = inject(EnvironmentStatusApi);
  private readonly errors = inject(ErrorHandler);
  private loadToken = 0;

  readonly state = signal<EnvironmentLoadState>('idle');
  readonly problem = signal<EnvironmentProblem | null>(null);
  /** The last good answer, kept through later failures. */
  readonly snapshot = signal<EnvironmentStatusDto | null>(null);
  /** ISO time of the last good answer. */
  readonly checkedAt = signal<string | null>(null);

  /** The first read; later visits reuse it until Check again. */
  ensureLoaded(): Promise<void> {
    return this.state() === 'idle' ? this.load() : Promise.resolve();
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    this.state.set('loading');
    try {
      const body = await this.api.load();
      if (token === this.loadToken) {
        this.snapshot.set(body);
        this.checkedAt.set(new Date().toISOString());
        this.problem.set(null);
        this.state.set('ready');
      }
    } catch (error: unknown) {
      if (!(error instanceof HttpErrorResponse) && !(error instanceof UnexpectedEnvironmentResponse)) {
        this.errors.handleError(error);
      }
      if (token === this.loadToken) {
        const problem = environmentProblemOf(error);
        if (problem.kind === 'forbidden') {
          // Nothing of an earlier answer stays on screen for a session that is not the owner's.
          this.snapshot.set(null);
          this.checkedAt.set(null);
        }
        this.problem.set(problem);
        this.state.set('error');
      }
    }
  }

  statusOf(id: string): EnvironmentItemStatus | null {
    return this.snapshot()?.items.find((item) => item.id === id)?.status ?? null;
  }
}
