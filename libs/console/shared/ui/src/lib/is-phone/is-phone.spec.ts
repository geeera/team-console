import { BreakpointObserver, type BreakpointState } from '@angular/cdk/layout';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { isPhoneSignal } from './is-phone';

describe('isPhoneSignal', () => {
  function configure(initial: boolean) {
    const state = new BehaviorSubject<BreakpointState>({ matches: initial, breakpoints: {} });
    const observe = vi.fn(() => state.asObservable());
    TestBed.configureTestingModule({
      providers: [
        { provide: BreakpointObserver, useValue: { isMatched: () => state.value.matches, observe } },
      ],
    });
    return { state, observe };
  }

  it('starts with the observer current match, no flash', () => {
    configure(true);
    const isPhone = TestBed.runInInjectionContext(() => isPhoneSignal());
    expect(isPhone()).toBe(true);
  });

  it('follows the viewport as it changes', () => {
    const { state } = configure(false);
    const isPhone = TestBed.runInInjectionContext(() => isPhoneSignal());
    expect(isPhone()).toBe(false);

    state.next({ matches: true, breakpoints: {} });
    TestBed.tick();
    expect(isPhone()).toBe(true);
  });

  it('observes the phone breakpoint from BREAKPOINTS', () => {
    const { observe } = configure(false);
    TestBed.runInInjectionContext(() => isPhoneSignal());
    expect(observe).toHaveBeenCalledWith(BREAKPOINTS.phone);
  });
});
