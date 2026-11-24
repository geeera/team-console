import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, IconName } from '../icon/icon';

/**
 * A small wax seal on a paper row (ADR 0002): a round `--accent-soft` mark with an icon, the way a private letter
 * is closed. The `label` is its name for assistive tech and its hover hint; colour never carries the meaning alone.
 * The hint is the native `title`, since a row's clipping surface would cut a kit tooltip off.
 *
 * ```html
 * <tc-seal icon="lock" label="Private" />
 * ```
 */
@Component({
  selector: 'tc-seal',
  imports: [Icon],
  template: `
    <tc-icon [name]="icon()" size="sm" />
    <span class="tc-sr-only">{{ label() }}</span>
  `,
  styleUrl: './seal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-seal', '[attr.title]': 'label()' },
})
export class Seal {
  readonly icon = input.required<IconName>();
  /** What the seal says, in words: «Приватный». */
  readonly label = input.required<string>();
}
