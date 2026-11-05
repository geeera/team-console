import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon } from '../icon/icon';

/**
 * A value you press to change (#409): the current value underlined with a chevron, opening a `Menu`. Its accessible
 * name carries the field and the value ("Status: Approved"), and it says it opens a menu. When it cannot be used
 * (`off` = the reason, e.g. "You're offline") it stays focusable with `aria-disabled` and the reason linked by
 * `aria-describedby` from the caller — never `disabled` (#107's rule). Content before the value (a status dot) is
 * projected; the value itself is `value`.
 *
 * ```html
 * <button tc-picker type="button" [field]="t('item.status')" [value]="t('board.status.qa')" [expanded]="open()"
 *   (click)="pick($event)"><i class="dot"></i></button>
 * ```
 */
@Component({
  selector: 'button[tc-picker]',
  imports: [Icon],
  template: `
    <ng-content />
    <span class="tc-picker__value">{{ value() }}</span>
    <tc-icon class="tc-picker__chevron" name="chevron-down" size="sm" />
  `,
  styleUrl: './picker-button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-picker',
    '[class.tc-picker--changed]': 'changed()',
    'aria-haspopup': 'menu',
    '[attr.aria-expanded]': 'expanded() ? "true" : "false"',
    '[attr.aria-label]': 'name()',
    '[attr.aria-disabled]': 'off() ? "true" : null',
  },
})
export class PickerButton {
  /** The field's label, already translated. */
  readonly field = input.required<string>();
  /** The current value as shown, already translated. */
  readonly value = input.required<string>();
  readonly expanded = input(false, { transform: booleanAttribute });
  /** Set while the control cannot be used; the reason is shown by the caller. */
  readonly off = input(false, { transform: booleanAttribute });
  /** The value just changed: the ink settles once (no motion under reduced motion). */
  readonly changed = input(false, { transform: booleanAttribute });

  protected readonly name = computed(() => `${this.field()}: ${this.value()}`);
}
