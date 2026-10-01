import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Callout, CalloutTone } from './callout';

@Component({
  imports: [Callout],
  template: `
    <section tc-callout [tone]="tone()" aria-labelledby="t">
      <h2 tc-callout-title id="t">Project not added</h2>
      <p>Nothing was saved.</p>
    </section>
  `,
})
class Host {
  readonly tone = signal<CalloutTone>('neutral');
}

describe('Callout', () => {
  it('keeps the caller’s element and heading, and marks the tone with a class only', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const section = (fixture.nativeElement as HTMLElement).querySelector('section') as HTMLElement;

    expect(section.classList).toContain('tc-callout');
    expect(section.querySelector('h2')?.textContent).toBe('Project not added');
    expect(section.className).not.toContain('tc-callout--danger');

    fixture.componentInstance.tone.set('danger');
    await fixture.whenStable();
    expect(section.classList).toContain('tc-callout--danger');
  });
});
