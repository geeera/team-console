import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Seal } from './seal';

@Component({
  imports: [Seal],
  template: `<tc-seal icon="lock" label="Private" />`,
})
class Host {}

describe('Seal', () => {
  it('names itself for assistive tech and as a hover hint', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const seal = (fixture.nativeElement as HTMLElement).querySelector('tc-seal') as HTMLElement;

    expect(seal.getAttribute('title')).toBe('Private');
    expect(seal.textContent?.trim()).toBe('Private');
    expect(seal.querySelector('tc-icon')?.getAttribute('aria-hidden')).toBe('true');
  });
});
