import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable, signal } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import {
  ENVIRONMENT_STATUS_PROJECT_PARAM,
  ENVIRONMENT_STATUS_URL,
  isEnvironmentStatusDto,
  type EnvironmentItemStatus,
  type EnvironmentStatusDto,
} from '@shared/environment';
import { firstValueFrom } from 'rxjs';

/** The answer did not have the shape #104 promises, or held rows of another scope (#750); nothing of it is used. */
export class UnexpectedEnvironmentResponse extends Error {
  constructor() {
    super(`unexpected response shape from ${ENVIRONMENT_STATUS_URL}`);
    this.name = 'UnexpectedEnvironmentResponse';
  }
}

/** Whether every item belongs to the scope asked for: the console's own rows, or one project's only. */
function isInScope(body: EnvironmentStatusDto, project: string | null): boolean {
  return body.items.every((item) =>
    project === null ? !item.id.startsWith('project/') : item.id.startsWith(`project/${project}/`),
  );
}

@Injectable({ providedIn: 'root' })
export class EnvironmentStatusApi {
  private readonly http = inject(HttpClient);

  /** The console's own rows (`project` null), or one project's rows only (`?project=<slug>`, #750). */
  async load(project: string | null = null): Promise<EnvironmentStatusDto> {
    const body = await firstValueFrom(
      this.http.get<unknown>(
        ENVIRONMENT_STATUS_URL,
        project === null ? {} : { params: { [ENVIRONMENT_STATUS_PROJECT_PARAM]: project } },
      ),
    );
    if (!isEnvironmentStatusDto(body) || !isInScope(body, project)) {
      throw new UnexpectedEnvironmentResponse();
    }
    return body;
  }
}

/** Why the status could not be read, from the HTTP status only (never `detail`). */
export type EnvironmentProblem =
  | { readonly kind: 'failed' }
  | { readonly kind: 'offline' }
  /** 403: not the operator (a session user, the dev/stage service identity); nothing of the list is shown. */
  | { readonly kind: 'forbidden' }
  /** 404 on a project's status: archived, unknown or outside the scope — one answer for all three (#750). */
  | { readonly kind: 'not-found' }
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
  if (problem.status === 404) {
    return { kind: 'not-found' };
  }
  if (problem.status === 429) {
    const seconds = problem.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
    return { kind: 'rate', retryAt: new Date(now + seconds * 1000).toISOString() };
  }
  return { kind: 'failed' };
}

export type EnvironmentLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One scope's environment status: the console's own rows or one project's. Statuses stay in memory only — never in
 * `tc.state.v1` or any storage — and the last good answer is kept through a failed re-check, so an offline screen
 * shows it with its time. A 403 or a 404 drops it: nothing of an earlier answer stays for a session that may not see
 * it, or for a project that is gone.
 */
export class EnvironmentStatusState {
  private loadToken = 0;

  readonly state = signal<EnvironmentLoadState>('idle');
  readonly problem = signal<EnvironmentProblem | null>(null);
  /** The last good answer, kept through later failures. */
  readonly snapshot = signal<EnvironmentStatusDto | null>(null);
  /** ISO time of the last good answer. */
  readonly checkedAt = signal<string | null>(null);

  constructor(
    private readonly api: EnvironmentStatusApi,
    private readonly errors: ErrorHandler,
    /** `null` for the console's own rows. */
    readonly project: string | null,
  ) {}

  /** The first read; later visits reuse it until Check again. */
  ensureLoaded(): Promise<void> {
    return this.state() === 'idle' ? this.load() : Promise.resolve();
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    this.state.set('loading');
    try {
      const body = await this.api.load(this.project);
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
        if (problem.kind === 'forbidden' || problem.kind === 'not-found') {
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

/**
 * This console's own environment status (#104): shared by the Settings operator row and the operator screen
 * (`/admin/environment`, #750), so both show the same call. A 200 is today's operator signal (#750 UX spec §1).
 */
@Injectable({ providedIn: 'root' })
export class EnvironmentStatusStore extends EnvironmentStatusState {
  constructor() {
    super(inject(EnvironmentStatusApi), inject(ErrorHandler), null);
  }
}

/**
 * One status per project (#750), kept for the session: the project setup row and the project's environment screen
 * read the same one, and a project's screen never asks for another project's rows.
 */
@Injectable({ providedIn: 'root' })
export class ProjectEnvironmentStatuses {
  private readonly api = inject(EnvironmentStatusApi);
  private readonly errors = inject(ErrorHandler);
  private readonly byProject = new Map<string, EnvironmentStatusState>();

  of(project: string): EnvironmentStatusState {
    let status = this.byProject.get(project);
    if (status === undefined) {
      status = new EnvironmentStatusState(this.api, this.errors, project);
      this.byProject.set(project, status);
    }
    return status;
  }
}
