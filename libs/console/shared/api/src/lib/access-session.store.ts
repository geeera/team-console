import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { reloginUrlOf } from './access-session';

/** The page's address and a full-page navigation, behind a token so tests do not navigate the test runner. */
export interface PageLocation {
  readonly href: string;
  assign(url: string): void;
}

export const PAGE_LOCATION = new InjectionToken<PageLocation>('PAGE_LOCATION', {
  providedIn: 'root',
  factory: () => inject(DOCUMENT).location,
});

/**
 * Whether Cloudflare Access wants a new login (#284). Set by `accessSessionInterceptor`; the app root shows the
 * expired-session state instead of the screens, whose own error states would only say "something went wrong".
 */
@Injectable({ providedIn: 'root' })
export class AccessSession {
  private readonly location = inject(PAGE_LOCATION);
  private readonly isExpired = signal(false);

  readonly expired = this.isExpired.asReadonly();

  markExpired(): void {
    this.isExpired.set(true);
  }

  /** A full-page navigation to where the owner is, past the service worker, so Access can run its login. */
  signIn(): void {
    this.location.assign(reloginUrlOf(this.location.href));
  }
}
