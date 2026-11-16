import { Directive } from '@angular/core';
import { isPhoneSignal } from '../is-phone/is-phone';

/**
 * Keeps an element for assistive tech only on the phone, where the top bar already shows the same words — a page's
 * `h1` there would repeat the title (#204). Wider screens show it as usual. It adds the global `.tc-sr-only`, so the
 * element stays in the accessibility tree and can still take focus.
 *
 * ```html
 * <h1 tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">Needs you</h1>
 * ```
 */
@Directive({
  selector: '[tcSrOnlyOnPhone]',
  host: { '[class.tc-sr-only]': 'isPhone()' },
})
export class SrOnlyOnPhone {
  protected readonly isPhone = isPhoneSignal();
}
