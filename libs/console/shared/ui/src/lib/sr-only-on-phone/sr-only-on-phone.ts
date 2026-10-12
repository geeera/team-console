import { BreakpointObserver } from '@angular/cdk/layout';
import { Directive, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';

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
  private readonly breakpoints = inject(BreakpointObserver);

  protected readonly isPhone = toSignal(
    this.breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );
}
