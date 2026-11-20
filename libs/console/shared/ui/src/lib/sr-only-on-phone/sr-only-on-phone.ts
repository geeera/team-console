import { Directive, signal } from '@angular/core';
import { isPhoneSignal } from '../is-phone/is-phone';

/**
 * Keeps an element for assistive tech only on the phone, where the top bar already shows the same words — a page's
 * `h1` there would repeat the title (#204). Wider screens show it as usual. It adds the global `.tc-sr-only`, so the
 * element stays in the accessibility tree and can still take focus; while it has focus it is shown, so a keyboard
 * user on a phone never has focus on something invisible (#212).
 *
 * ```html
 * <h1 tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">Needs you</h1>
 * ```
 */
@Directive({
  selector: '[tcSrOnlyOnPhone]',
  host: {
    '[class.tc-sr-only]': 'isPhone() && !isFocused()',
    '(focus)': 'isFocused.set(true)',
    '(blur)': 'isFocused.set(false)',
  },
})
export class SrOnlyOnPhone {
  protected readonly isPhone = isPhoneSignal();
  protected readonly isFocused = signal(false);
}
