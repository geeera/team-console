import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

/**
 * The app's mark on a rounded tile, the way an installed icon sits on a Home Screen or in the Dock (#761). Always
 * decorative: the text beside it names the app. `small` is the one-line size (a hint, a success line).
 */
@Component({
  selector: 'tc-app-tile',
  imports: [Icon],
  template: `<tc-icon name="stack" [size]="small() ? 'sm' : 'lg'" />`,
  styleUrl: './app-tile.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-app-tile',
    '[class.tc-app-tile--sm]': 'small()',
    'aria-hidden': 'true',
  },
})
export class AppTile {
  readonly small = input(false, { transform: booleanAttribute });
}
