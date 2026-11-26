import { Directive } from '@angular/core';
import { isPhoneSignal } from '../is-phone/is-phone';

/**
 * Keeps an element for assistive tech only on the phone, where the top bar already shows the same words — a page's
 * `h1` there would repeat the title (#204). Wider screens show it as usual. It adds the global `.tc-sr-only`, so the
 * element stays in the accessibility tree and takes programmatic focus for route arrival, which announces the title.
 * It is never shown on focus: a focus target must not change layout, or the press that moves focus off it lands on
 * whatever slid under the pointer (#1031). Accepted tradeoff: a sighted keyboard user on the phone has focus on an
 * invisible title for one step (#212); the top bar shows the same title and the next Tab is visible.
 *
 * ```html
 * <h1 tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">Needs you</h1>
 * ```
 */
@Directive({
  selector: '[tcSrOnlyOnPhone]',
  host: {
    '[class.tc-sr-only]': 'isPhone()',
  },
})
export class SrOnlyOnPhone {
  protected readonly isPhone = isPhoneSignal();
}
