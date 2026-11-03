import { HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable, signal } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import { isGitHubPageUrl, type InstallationRepositoryDto } from '@shared/contracts';
import {
  InstallationRepositoriesApi,
  UnexpectedInstallationRepositoriesResponse,
} from './installation-repositories';

/** Why the list could not be shown, from the problem `type` only (never `detail`). */
export type RepositoriesProblem =
  /** 403 `github-owner-not-connected`: the console shows Connect and sends nothing more. */
  | { readonly kind: 'not-connected' }
  /** 409 `github-app-not-installed`: the install link comes from the server, checked to be on github.com. */
  | { readonly kind: 'not-installed'; readonly installUrl: string | null }
  | { readonly kind: 'github' }
  | { readonly kind: 'rate'; readonly retryAt: string }
  /** 503 `github-auth`: the console's own app credential is broken. */
  | { readonly kind: 'auth' }
  /** No response at all. */
  | { readonly kind: 'offline' };

export type RepositoriesStatus = 'idle' | 'loading' | 'ready' | 'error';

// Without Retry-After the Worker's own default applies; GitHub's docs say to wait at least a minute.
const DEFAULT_RETRY_SECONDS = 60;

/** Maps a failed list read to its view state; anything unrecognised is "GitHub didn't respond". */
export function repositoriesProblemOf(error: unknown, now: number = Date.now()): RepositoriesProblem {
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'github' };
  }
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return { kind: 'offline' };
  }
  if (problem.slug === 'github-rate-limit' || problem.status === 429) {
    const seconds = problem.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
    return { kind: 'rate', retryAt: new Date(now + seconds * 1000).toISOString() };
  }
  switch (problem.slug) {
    case 'github-owner-not-connected':
      return { kind: 'not-connected' };
    case 'github-app-not-installed': {
      const installUrl = problem.extensions['installUrl'];
      return { kind: 'not-installed', installUrl: isGitHubPageUrl(installUrl) ? installUrl : null };
    }
    case 'github-auth':
      return { kind: 'auth' };
    default:
      return { kind: 'github' };
  }
}

/**
 * The repositories the console app's installation can see (#194), for All projects. A reload keeps the rows on
 * screen (`refreshing`); a failed reload while offline keeps them too, so the list stays readable with a dated note.
 */
@Injectable({ providedIn: 'root' })
export class InstallationRepositoriesStore {
  private readonly api = inject(InstallationRepositoriesApi);
  private readonly errors = inject(ErrorHandler);
  private loadToken = 0;

  readonly status = signal<RepositoriesStatus>('idle');
  readonly problem = signal<RepositoriesProblem | null>(null);
  readonly repositories = signal<readonly InstallationRepositoryDto[]>([]);
  readonly partial = signal(false);
  readonly selectionUrl = signal<string | null>(null);
  /** ISO time of the last successful read: the offline note dates the list with it. */
  readonly loadedAt = signal<string | null>(null);
  readonly refreshing = signal(false);

  /** Resolves `ready` or `error` once this load (not a newer one) has settled. */
  async load(options: { readonly fresh?: boolean } = {}): Promise<'ready' | 'error'> {
    const token = ++this.loadToken;
    const hadList = this.status() === 'ready';
    if (hadList) {
      this.refreshing.set(true);
    } else {
      this.status.set('loading');
      this.problem.set(null);
    }
    try {
      const body = await this.api.load(options);
      if (token === this.loadToken) {
        this.repositories.set(body.repositories);
        this.partial.set(body.partial);
        this.selectionUrl.set(body.selectionUrl);
        this.loadedAt.set(new Date().toISOString());
        this.problem.set(null);
        this.status.set('ready');
      }
      return 'ready';
    } catch (error: unknown) {
      if (
        !(error instanceof HttpErrorResponse) &&
        !(error instanceof UnexpectedInstallationRepositoriesResponse)
      ) {
        this.errors.handleError(error);
      }
      const problem = repositoriesProblemOf(error);
      if (token === this.loadToken && !(hadList && problem.kind === 'offline')) {
        this.problem.set(problem);
        this.status.set('error');
      }
      return 'error';
    } finally {
      if (token === this.loadToken) {
        this.refreshing.set(false);
      }
    }
  }

  /** The row turns "Project" at once after an add, before any reload (#194 AC). */
  markRegistered(fullName: string, slug: string): void {
    const wanted = fullName.toLowerCase();
    this.repositories.update((repositories) =>
      repositories.map((repo) =>
        repo.fullName.toLowerCase() === wanted ? { ...repo, registration: { state: 'active', slug } } : repo,
      ),
    );
  }
}
