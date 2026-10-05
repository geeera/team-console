import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Spinner } from '../spinner/spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md';

/**
 * A button on top of the native element (or an anchor when it navigates), so keyboard,
 * focus and `disabled` semantics stay the browser's. `loading` announces `aria-busy`
 * and shows the spinner in front of the label; the caller decides whether to disable it.
 */
@Component({
  selector: 'button[tc-button], a[tc-button]',
  imports: [Spinner],
  template: `
    @if (loading()) {
      <tc-spinner />
    }
    <ng-content />
  `,
  styleUrl: './button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-button',
    '[class.tc-button--primary]': 'variant() === "primary"',
    '[class.tc-button--secondary]': 'variant() === "secondary"',
    '[class.tc-button--quiet]': 'variant() === "quiet"',
    '[class.tc-button--danger]': 'variant() === "danger"',
    '[class.tc-button--sm]': 'size() === "sm"',
    '[class.tc-button--block]': 'block()',
    '[class.tc-button--loading]': 'loading()',
    '[class.tc-button--off]': 'off()',
    '[attr.aria-busy]': 'loading() ? "true" : null',
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('secondary');
  readonly size = input<ButtonSize>('md');
  /** Full width; the phone layout stacks actions this way. */
  readonly block = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
  /**
   * Off with a reason (#114): the button stays focusable and readable but no longer looks pressable (a dashed edge).
   * The caller sets `aria-disabled="true"`, points `aria-describedby` at the visible reason and, on click, says why
   * instead of acting — a disabled button would hide the reason from keyboard and screen-reader users.
   */
  readonly off = input(false, { transform: booleanAttribute });
}

/**
 * A square button that holds one icon. It has no visible text, so `aria-label`
 * is required on the element — stories and lint keep that honest.
 */
@Component({
  selector: 'button[tc-icon-button], a[tc-icon-button]',
  template: '<ng-content />',
  styleUrl: './icon-button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-icon-button' },
})
export class IconButton {}
