import { BreakpointObserver } from '@angular/cdk/layout';
import { inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';

/**
 * Whether the viewport is at the phone breakpoint, as a signal that starts with the observer's current
 * match (no flash) and follows resizes (#621, was copy-pasted verbatim across the overview, needs-you and
 * project-space pages). Call it from a field initializer or constructor, where Angular's injection context
 * is available — the same place `inject()` is called.
 */
export function isPhoneSignal(): Signal<boolean> {
  const breakpoints = inject(BreakpointObserver);
  return toSignal(breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)), {
    initialValue: breakpoints.isMatched(BREAKPOINTS.phone),
  });
}
