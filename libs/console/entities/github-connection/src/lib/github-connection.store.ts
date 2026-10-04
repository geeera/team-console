import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { httpProblemOf, type HttpProblem } from '@console/shared/api';
import {
  GITHUB_CONNECT_PATH,
  githubAuthorizeUrlOf,
  isGitHubLogin,
  isGitHubPageUrl,
  type GitHubConnectionDto,
  type GitHubConnectOutcome,
  type GitHubDisconnectIncompleteDto,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export const GITHUB_CONNECTION_URL = '/api/v1/github/connection';

/** What Settings shows: `lost` is "not connected" right after it last showed "connected" (#24 AC 2). */
export type GitHubConnectionView = 'loading' | 'connected' | 'not-connected' | 'lost' | 'error';

export type ConnectStartResult =
  | { readonly kind: 'navigating' }
  /** The Worker answered an address that is not GitHub's authorize page: nothing was opened. */
  | { readonly kind: 'refused-url' }
  | { readonly kind: 'failed'; readonly problem: HttpProblem };

export type DisconnectResult =
  | { readonly kind: 'revoked' }
  /** Gone from the console, but GitHub did not confirm the revoke: the owner revokes it there. */
  | { readonly kind: 'revoke-on-github'; readonly manageUrl: string | null };

/** The `?github=` outcome the OAuth callback appends to /settings, with the other login on `wrong-account`. */
export type ConnectOutcome =
  | { readonly kind: Exclude<GitHubConnectOutcome, 'wrong-account'> }
  | { readonly kind: 'wrong-account'; readonly login: string | null };

const OUTCOMES: readonly GitHubConnectOutcome[] = ['connected', 'denied', 'wrong-account', 'failed'];

function isOutcome(value: unknown): value is GitHubConnectOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

/** Reads the callback's query; anything unexpected is ignored rather than shown. */
export function connectOutcomeOf(github: unknown, login: unknown): ConnectOutcome | null {
  if (!isOutcome(github)) {
    return null;
  }
  if (github === 'wrong-account') {
    return { kind: 'wrong-account', login: isGitHubLogin(login) ? login : null };
  }
  return { kind: github };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isGitHubConnectionDto(value: unknown): value is GitHubConnectionDto {
  if (!isRecord(value) || typeof value['appName'] !== 'string') {
    return false;
  }
  if (value['state'] === 'connected') {
    return isGitHubLogin(value['login']) && isOptionalString(value['connectedAt']);
  }
  return (
    value['state'] === 'not-connected' &&
    (value['ownerLogin'] === undefined || isGitHubLogin(value['ownerLogin']))
  );
}

function isConnectStart(value: unknown): value is { authorizeUrl: unknown } {
  return isRecord(value) && 'authorizeUrl' in value;
}

function isDisconnectIncomplete(value: unknown): value is GitHubDisconnectIncompleteDto {
  return isRecord(value) && value['revoked'] === false && value['action'] === 'revoke-on-github';
}

/** The state after the connection ended: the account it was stays the one the console accepts. */
function notConnectedFrom(current: GitHubConnectionDto | null): GitHubConnectionDto {
  const ownerLogin = current?.state === 'connected' ? current.login : current?.ownerLogin;
  return {
    state: 'not-connected',
    appName: current?.appName ?? '',
    ...(ownerLogin === undefined ? {} : { ownerLogin }),
  };
}

/** Leaving the app for GitHub, behind a service so specs never navigate the test runner. */
@Injectable({ providedIn: 'root' })
export class ExternalNavigation {
  private readonly document = inject(DOCUMENT);

  assign(url: string): void {
    this.document.location.assign(url);
  }
}

/**
 * The owner's GitHub connection (#59) as Settings shows it: loaded from the Worker, never assumed. Other screens
 * report what the Worker told them (`noteNotConnected` on a 403 `github-owner-not-connected`, `syncFrom` with a
 * setup status) so a connection that was lost meanwhile reads as lost, not as "never connected".
 */
@Injectable({ providedIn: 'root' })
export class GitHubConnectionStore {
  private readonly http = inject(HttpClient);
  private readonly navigation = inject(ExternalNavigation);

  private readonly dto = signal<GitHubConnectionDto | null>(null);
  private pending: Promise<void> | null = null;

  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly lost = signal(false);
  /** Why the last load failed, when it was an HTTP answer; null for a body of the wrong shape. */
  readonly loadProblem = signal<HttpProblem | null>(null);

  readonly view = computed<GitHubConnectionView>(() => {
    const dto = this.dto();
    if (dto === null) {
      return this.status() === 'error' ? 'error' : 'loading';
    }
    if (dto.state === 'connected') {
      return 'connected';
    }
    return this.lost() ? 'lost' : 'not-connected';
  });
  readonly isConnected = computed(() => this.view() === 'connected');
  readonly login = computed(() => {
    const dto = this.dto();
    return dto?.state === 'connected' ? (dto.login ?? null) : null;
  });
  /** The account the console accepts: the connected login, or the configured owner login before a connect (#89). */
  readonly ownerLogin = computed(() => this.login() ?? this.dto()?.ownerLogin ?? null);
  readonly connectedAt = computed(() => this.dto()?.connectedAt ?? null);
  readonly appName = computed(() => this.dto()?.appName ?? null);

  ready(): Promise<void> {
    return this.status() === 'idle' ? this.load() : (this.pending ?? Promise.resolve());
  }

  load(): Promise<void> {
    if (this.pending !== null) {
      return this.pending;
    }
    this.status.set('loading');
    this.pending = (async () => {
      try {
        const body = await firstValueFrom(this.http.get<unknown>(GITHUB_CONNECTION_URL));
        if (!isGitHubConnectionDto(body)) {
          throw new Error('github connection: unexpected response shape');
        }
        this.apply(body);
        this.status.set('ready');
      } catch (error: unknown) {
        // Recorded, not thrown into a template: the last known state stays; with none, the view reads `error`.
        this.loadProblem.set(error instanceof HttpErrorResponse ? httpProblemOf(error) : null);
        this.status.set('error');
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** A 403 `github-owner-not-connected` from any call: the connection is gone now. */
  noteNotConnected(): void {
    const current = this.dto();
    if (current?.state === 'connected') {
      this.lost.set(true);
      this.dto.set(notConnectedFrom(current));
    }
  }

  /** The connection state a setup status carried; a change the store did not know about is reloaded or noted. */
  syncFrom(state: 'connected' | 'not-connected'): void {
    if (state === 'not-connected') {
      this.noteNotConnected();
    } else if (this.dto()?.state !== 'connected') {
      void this.load();
    }
  }

  /** Starts the OAuth round trip: navigates only to GitHub's authorize page, see `isGitHubAuthorizeUrl`. */
  async connect(): Promise<ConnectStartResult> {
    let body: unknown;
    try {
      body = await firstValueFrom(this.http.post<unknown>(GITHUB_CONNECT_PATH, {}));
    } catch (error: unknown) {
      return { kind: 'failed', problem: httpProblemOf(error) };
    }
    const authorizeUrl = githubAuthorizeUrlOf(isConnectStart(body) ? body.authorizeUrl : undefined);
    if (authorizeUrl === null) {
      return { kind: 'refused-url' };
    }
    this.navigation.assign(authorizeUrl);
    return { kind: 'navigating' };
  }

  /** Ends the grant. Throws when the Worker refused, so a confirm dialog can stay open with its error. */
  async disconnect(): Promise<DisconnectResult> {
    const response = await firstValueFrom(
      this.http.delete<unknown>(GITHUB_CONNECTION_URL, { observe: 'response' }),
    );
    this.lost.set(false);
    this.dto.set(notConnectedFrom(this.dto()));
    const body: unknown = response instanceof HttpResponse ? response.body : null;
    if (response.status === 200 && isDisconnectIncomplete(body)) {
      return { kind: 'revoke-on-github', manageUrl: isGitHubPageUrl(body.manageUrl) ? body.manageUrl : null };
    }
    return { kind: 'revoked' };
  }

  private apply(next: GitHubConnectionDto): void {
    const previous = this.dto();
    if (next.state === 'connected') {
      this.lost.set(false);
    } else if (previous?.state === 'connected') {
      this.lost.set(true);
    }
    this.dto.set(next);
  }
}
