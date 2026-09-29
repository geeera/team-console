import { DOCUMENT } from '@angular/common';
import {
  HttpErrorResponse,
  HttpResponse,
  type HttpEvent,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { NEVER, catchError, map, throwError } from 'rxjs';

/** sessionStorage key holding the time of the last re-login reload. */
export const REAUTH_FLAG_KEY = 'tc.reauth';
/** A second reload within this window means re-login did not help: stop and show the error instead. */
export const REAUTH_LOOP_GUARD_MS = 30_000;

/** Problem slugs after which signing in again can help; `access-forbidden`/`-misconfigured` would just loop. */
const REAUTH_PROBLEM_TYPE = /\/(access-missing|access-unverified)$/;

/** The browser side effects the interceptor needs, behind a token so tests do not reload the test runner. */
export interface ReauthEnvironment {
  now(): number;
  isOnline(): boolean;
  /** Null when there is no flag or storage is unavailable. */
  readFlag(): string | null;
  /** False when storage refused the write (private mode, quota) — then there is no loop guard, so no reload. */
  writeFlag(value: string): boolean;
  reload(): void;
}

export const REAUTH_ENVIRONMENT = new InjectionToken<ReauthEnvironment>('REAUTH_ENVIRONMENT', {
  providedIn: 'root',
  factory: () => browserReauthEnvironment(inject(DOCUMENT)),
});

function browserReauthEnvironment(document: Document): ReauthEnvironment {
  const view = document.defaultView;
  return {
    now: () => Date.now(),
    isOnline: () => view?.navigator.onLine ?? true,
    readFlag: () => {
      try {
        return view?.sessionStorage.getItem(REAUTH_FLAG_KEY) ?? null;
      } catch {
        // Storage disabled: behave as if no reload happened; writeFlag then fails and prevents the reload.
        return null;
      }
    },
    writeFlag: (value) => {
      try {
        if (view === null) {
          return false;
        }
        view.sessionStorage.setItem(REAUTH_FLAG_KEY, value);
        return true;
      } catch {
        return false;
      }
    },
    reload: () => view?.location.reload(),
  };
}

function isApiRequest(url: string, document: Document): boolean {
  const base = document.baseURI;
  const target = new URL(url, base);
  return (
    target.origin === new URL(base).origin &&
    (target.pathname === '/api' || target.pathname.startsWith('/api/'))
  );
}

/** A declared non-JSON body (Access's login page is text/html); no header at all is not evidence either way. */
function isDeclaredNonJson(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType !== 'application/json' && !mediaType.endsWith('+json');
}

function problemTypeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const type: unknown = (body as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : null;
}

/**
 * Does this API failure mean the Access session is gone? An expired session makes Access answer our fetch with a
 * cross-origin redirect (status 0 in the browser) or an HTML login page (non-JSON, often with status 200 and a
 * parse error); with Access off, the Worker answers 401 `access-missing`/`access-unverified`.
 */
export function needsReauthentication(error: HttpErrorResponse): boolean {
  if (error.status === 0) {
    return true;
  }
  if (isDeclaredNonJson(error.headers.get('Content-Type'))) {
    return true;
  }
  const type = problemTypeOf(error.error);
  return error.status === 401 && type !== null && REAUTH_PROBLEM_TYPE.test(type);
}

/**
 * Reloads the page so Access can run its login, at most once per 30 s (ADR 0001 consequence "Access session
 * expires"). Offline failures also have status 0 but a reload cannot fix them, so they pass through as errors.
 */
export const accessSessionInterceptor: HttpInterceptorFn = (request, next) => {
  const document = inject(DOCUMENT);
  const environment = inject(REAUTH_ENVIRONMENT);

  if (!isApiRequest(request.url, document)) {
    return next(request);
  }

  return next(request).pipe(
    map((event: HttpEvent<unknown>) => {
      // An HTML body for a JSON request (Access's login page after a same-origin redirect) is a failure even
      // when it arrives as 200 and the backend did not try to parse it.
      if (
        event instanceof HttpResponse &&
        request.responseType === 'json' &&
        event.body !== null &&
        isDeclaredNonJson(event.headers.get('Content-Type'))
      ) {
        throw new HttpErrorResponse({
          error: event.body,
          headers: event.headers,
          status: event.status,
          statusText: event.statusText,
          ...(event.url === null ? {} : { url: event.url }),
        });
      }
      return event;
    }),
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || !needsReauthentication(error) || !environment.isOnline()) {
        return throwError(() => error);
      }
      const now = environment.now();
      const lastReload = Number(environment.readFlag());
      const reloadedRecently =
        Number.isFinite(lastReload) && lastReload > 0 && now - lastReload < REAUTH_LOOP_GUARD_MS;
      if (reloadedRecently || !environment.writeFlag(String(now))) {
        return throwError(() => error);
      }
      environment.reload();
      // The page is going away; completing or erroring here would only flash an error state before the reload.
      return NEVER;
    }),
  );
};
