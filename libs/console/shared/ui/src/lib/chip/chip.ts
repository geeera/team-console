import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/**
 * A status pill: one short word, an optional dot. Colour never carries the meaning alone — the text does. A caller
 * with no room to spare (the phone top bar's environment mark at 390 px, #470 item 1) sets the `--chip-px`/`--chip-fs`
 * custom properties on an ancestor instead of a size input — see `chip.css` — since they cross the component
 * boundary a tag or class selector cannot, with no `::ng-deep`.
 */
@Component({
  selector: 'tc-chip',
  template: `
    @if (dot()) {
      <i class="tc-chip__dot" aria-hidden="true"></i>
    }
    <ng-content />
  `,
  styleUrl: './chip.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-chip',
    '[class.tc-chip--accent]': 'tone() === "accent"',
    '[class.tc-chip--success]': 'tone() === "success"',
    '[class.tc-chip--warning]': 'tone() === "warning"',
    '[class.tc-chip--danger]': 'tone() === "danger"',
  },
})
export class Chip {
  readonly tone = input<ChipTone>('neutral');
  readonly dot = input(false, { transform: booleanAttribute });
}
