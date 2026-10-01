import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';

/**
 * Whether the browser believes it is online. `navigator.onLine` is optimistic (a captive portal reads as online),
 * so screens use it only to disable writes up front; a failed request still reports its own error.
 */
@Injectable({ providedIn: 'root' })
export class NetworkStatus {
  private readonly view = inject(DOCUMENT).defaultView;

  readonly online = signal(this.view?.navigator.onLine ?? true);

  constructor() {
    const view = this.view;
    if (view === null) {
      return;
    }
    const update = (): void => this.online.set(view.navigator.onLine);
    view.addEventListener('online', update);
    view.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      view.removeEventListener('online', update);
      view.removeEventListener('offline', update);
    });
  }
}
