import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CardStamp } from '../card/card';
import { Recommendation } from '../recommendation/recommendation';
import { Receipt } from './receipt';

@Component({
  imports: [Receipt, Recommendation],
  template: `
    <tc-receipt [tone]="tone()">
      <span tc-receipt-verb>{{ verb() }}</span>
      <span tc-receipt-detail>Plan</span>
      <span tc-receipt-meta>#72</span>
    </tc-receipt>
    <tc-recommendation label="Team recommends">{{ verb() }}</tc-recommendation>
  `,
})
class Host {
  readonly tone = signal<CardStamp>('positive');
  readonly verb = signal('You: approve');
}

describe('Receipt and Recommendation', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, receipt: root.querySelector('tc-receipt') as HTMLElement };
  }

  it('a receipt is focusable from code and shows a decorative glyph per tone', async () => {
    const { fixture, receipt } = await render();

    expect(receipt.getAttribute('tabindex')).toBe('-1');
    expect(receipt.querySelector('tc-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(receipt.textContent).toContain('You: approve');

    fixture.componentInstance.tone.set('negative');
    await fixture.whenStable();
    expect(receipt.classList).toContain('tc-receipt--negative');
  });

  it('keeps projected text as text: markup in it is not parsed', async () => {
    const { fixture, root } = await render();

    fixture.componentInstance.verb.set('<img src=x onerror=alert(1)>');
    await fixture.whenStable();

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.tc-recommendation__choice')?.textContent).toContain('<img src=x');
    expect(root.querySelector('.tc-recommendation__label')?.textContent).toBe('Team recommends');
  });
});
