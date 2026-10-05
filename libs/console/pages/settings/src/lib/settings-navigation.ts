import { Router } from '@angular/router';

/** History state: the row index an archive from the setup page left, so the list moves focus as after a row archive. */
export const FOCUS_AFTER_ARCHIVE_STATE = 'tcFocusAfterArchive';

/**
 * A value the previous screen passed with this navigation. Read from the navigation in flight only, so a reload or
 * a back/forward visit of the same entry does not replay it ("Project added" stays a one-time message).
 */
export function readNavigationState(router: Router, key: string): unknown {
  return router.currentNavigation()?.extras.state?.[key];
}
