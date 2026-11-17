import { Injectable, signal } from '@angular/core';

/**
 * Whether the Commands pane is open beside a project space's section (#114). Provided by `ProjectSpacePage`, so a
 * section can drop its own copies of the pane's controls while both are on screen (#766: no duplicated buttons).
 */
@Injectable()
export class SpacePane {
  readonly isOpen = signal(false);
}
