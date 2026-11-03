import { BreakpointObserver, type BreakpointState } from '@angular/cdk/layout';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { SrOnlyOnPhone } from './sr-only-on-phone';

@Component({
  imports: [SrOnlyOnPhone],
  template: `<h1 tcSrOnlyOnPhone tabindex="-1">Title</h1>`,
})
class Host {}

describe('SrOnlyOnPhone', () => {
  async function render(phone: boolean) {
    const state = new BehaviorSubject<BreakpointState>({ matches: phone, breakpoints: {} });
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => state.value.matches, observe: () => state.asObservable() },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const heading = (fixture.nativeElement as HTMLElement).querySelector('h1') as HTMLElement;
    return { fixture, heading, state };
  }

  it('hides the element visually on the phone and keeps it as the heading', async () => {
    const { heading } = await render(true);

    expect(heading.classList.contains('tc-sr-only')).toBe(true);
    expect(heading.textContent).toBe('Title');
  });

  it('shows it on wider screens and follows the viewport as it changes', async () => {
    const { fixture, heading, state } = await render(false);
    expect(heading.classList.contains('tc-sr-only')).toBe(false);

    state.next({ matches: true, breakpoints: {} });
    await fixture.whenStable();
    expect(heading.classList.contains('tc-sr-only')).toBe(true);
  });
});
