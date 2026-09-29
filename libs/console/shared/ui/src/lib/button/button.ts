import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary';

/**
 * A plain button on top of the native element, so keyboard, focus and `disabled`
 * semantics stay the browser's. #13 replaces the visuals with the CDK-based kit.
 */
@Component({
  selector: 'button[tc-button]',
  template: '<ng-content />',
  styleUrl: './button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-button',
    '[class.tc-button--primary]': 'variant() === "primary"',
    '[class.tc-button--secondary]': 'variant() === "secondary"',
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('secondary');
}
