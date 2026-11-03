import { Router } from '@angular/router';

/**
 * A value the previous screen passed with this navigation. Read from the navigation in flight only, so a reload or
 * a back/forward visit of the same entry does not replay it ("Project added" stays a one-time message).
 */
export function readNavigationState(router: Router, key: string): unknown {
  return router.currentNavigation()?.extras.state?.[key];
}
