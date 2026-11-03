import {
  DestroyRef,
  type EnvironmentProviders,
  inject,
  Injectable,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { Router, type UrlTree } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { pushTargetOf, type PushTarget } from './push-target';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `notification.data.onActionClick.default.url` of an ngsw `NOTIFICATION_CLICK`, or undefined. */
export function tappedUrlOf(click: unknown): unknown {
  const notification = isRecord(click) ? click['notification'] : undefined;
  const data = isRecord(notification) ? notification['data'] : undefined;
  const onActionClick = isRecord(data) ? data['onActionClick'] : undefined;
  const action = isRecord(onActionClick) ? onActionClick['default'] : undefined;
  return isRecord(action) ? action['url'] : undefined;
}

/**
 * A tapped notification opens its target (#36). ngsw already navigates on a tap (`navigateLastFocusedOrOpen`); this
 * also routes inside an app that is already open, so the tap works without a reload. Only the targets
 * `pushTargetOf` accepts are followed, and the route is rebuilt from their checked parts, never from the raw string.
 */
@Injectable({ providedIn: 'root' })
export class PushTaps {
  private readonly router = inject(Router);
  private readonly swPush = inject(SwPush, { optional: true });

  start(): () => void {
    if (this.swPush === null || !this.swPush.isEnabled) {
      return () => undefined;
    }
    const subscription = this.swPush.notificationClicks.subscribe((click) => {
      const target = pushTargetOf(tappedUrlOf(click));
      if (target !== null) {
        void this.open(target);
      }
    });
    return () => subscription.unsubscribe();
  }

  /** `true` once the router shows the target; a tap on the screen already open just marks it again. */
  async open(target: PushTarget): Promise<boolean> {
    const tree = this.treeOf(target);
    return this.router.navigateByUrl(tree, { onSameUrlNavigation: 'reload' });
  }

  private treeOf(target: PushTarget): UrlTree {
    if (target.kind === 'needs-you') {
      return this.router.createUrlTree(['/needs-you']);
    }
    return this.router.createUrlTree(['/p', target.slug, 'questions'], { fragment: String(target.number) });
  }
}

/** Starts `PushTaps` with the app; registered once in the app config. */
export function providePushTaps(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      const stop = inject(PushTaps).start();
      inject(DestroyRef).onDestroy(stop);
    }),
  ]);
}
