import { DOCUMENT } from '@angular/common';
import {
  HttpErrorResponse,
  HttpResponse,
  type HttpEvent,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, map, throwError } from 'rxjs';
import { isAccessSessionExpired } from './access-session';
import { AccessSession } from './access-session.store';

function isApiRequest(url: string, document: Document): boolean {
  const base = document.baseURI;
  const target = new URL(url, base);
  return (
    target.origin === new URL(base).origin &&
    (target.pathname === '/api' || target.pathname.startsWith('/api/'))
  );
}

/**
 * Turns an expired Access session into `AccessSession.expired` (ADR 0001 consequence "Access session expires",
 * #284). Every `/api` call goes out with `redirect: 'manual'`, so Access's login redirect arrives as an
 * `opaqueredirect` instead of a CORS failure that looks like a dropped connection, and with `ngsw-bypass`, so
 * the service worker never turns that failure into a synthesised 504. The error still reaches the caller.
 */
export const accessSessionInterceptor: HttpInterceptorFn = (request, next) => {
  const document = inject(DOCUMENT);
  if (!isApiRequest(request.url, document)) {
    return next(request);
  }
  const session = inject(AccessSession);
  const outgoing = request.clone({ redirect: 'manual', setHeaders: { 'ngsw-bypass': 'true' } });

  return next(outgoing).pipe(
    map((event: HttpEvent<unknown>) => {
      // Access's HTML login page for a JSON request is a failure even when it arrives as 200 unparsed.
      if (
        event instanceof HttpResponse &&
        request.responseType === 'json' &&
        event.body !== null &&
        isAccessSessionExpired(event, event.body)
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
      if (error instanceof HttpErrorResponse && isAccessSessionExpired(error, error.error)) {
        session.markExpired();
      }
      return throwError(() => error);
    }),
  );
};
