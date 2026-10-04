import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type SpinnerSize = 'sm' | 'lg';

/**
 * An ink ring that turns; under reduced motion it stays still and pulses once.
 * Decorative on its own — the block or button around it says what is loading.
 */
@Component({
  selector: 'tc-spinner',
  template: '',
  styleUrl: './spinner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-spinner',
    '[class.tc-spinner--lg]': 'size() === "lg"',
    'aria-hidden': 'true',
  },
})
export class Spinner {
  readonly size = input<SpinnerSize>('sm');
}
